// decode() pulls in srv/bridge → @odatano/core; stub the barrel to its
// pure parser (see core-parse-mock) so its uncompiled .ts isn't loaded.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import { validatePayment } from '../../srv/core/validate';
import { transferMethodOf, isSupportedTransferMethod } from '../../srv/core/transfer-method';
import { selectFirstSupported } from '../../srv/client/select';
import { paymentCredentialOf } from '../../srv/helpers/address';
import { Codes } from '../../srv/core/errors';
import { decode } from '../../srv/core/decode';
import {
  BUYER_PRIV, BUYER_ADDR, BUYER_VKH, SELLER_ADDR,
  SCRIPT_ADDR, SCRIPT_HASH, OTHER_SCRIPT_HASH,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, FUTURE_SLOT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx, type TestOutput } from '../fixtures/build-tx';
import { buildEnvelope } from '../fixtures/envelope';
import type { PaymentRequirementEntry, ScriptTransferExtra } from '../../srv/core/types';

const DATUM = 'd8799f182aff';

function decodedWith(outputs: TestOutput[]) {
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs,
    ttlSlot: FUTURE_SLOT,
  });
  const signed = signTx(body, [BUYER_PRIV]);
  return decode(buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_REF }));
}

/** Hand-built so tests can carry extras `buildEntry` would refuse. */
function scriptEntry(extra: Partial<ScriptTransferExtra>, payTo = SCRIPT_ADDR): PaymentRequirementEntry {
  return {
    scheme: 'exact',
    network: NETWORK_PREPROD,
    asset: 'lovelace',
    amount: '2000000',
    payTo,
    resource: { url: '/lock', description: '', mimeType: 'application/json' },
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'script', scriptHash: SCRIPT_HASH, ...extra },
  };
}

describe('decode, inline datum', () => {
  it('exposes the inline datum of each output', () => {
    const d = decodedWith([
      { address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: DATUM },
      { address: BUYER_ADDR, lovelace: '1000000' },
    ]);
    expect(d.outputs[0]!.inlineDatumHex).toBe(DATUM);
    expect(d.outputs[1]!.inlineDatumHex).toBeNull();
  });
});

describe('validatePayment, script transfer', () => {
  it('accepts a lock at the declared script and reports the locked UTxO', () => {
    const d = decodedWith([
      { address: BUYER_ADDR, lovelace: '1000000' },
      { address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: DATUM },
    ]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claim.extra).toEqual({ assetTransferMethod: 'script', lockRefs: [`${d.txHash}#1`] });
    }
  });

  it('rejects when payTo is not the address of scriptHash', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({ scriptHash: OTHER_SCRIPT_HASH }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects when payTo is a key address', () => {
    const d = decodedWith([{ address: SELLER_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({}, SELLER_ADDR), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects when neither scriptHash nor script is declared', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({ scriptHash: undefined }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects a lock whose datum differs from extra.datum', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: 'd8799f182bff' }]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.DATUM_MISMATCH);
  });

  it('compares the datum as PlutusData, not byte for byte', () => {
    // Same constr 0 [42], declared with a definite-length list.
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: DATUM }]);
    const r = validatePayment(d, scriptEntry({ datum: 'd87981182a' }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
  });

  it('rejects when extra.datum is set but the lock carries no inline datum', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.DATUM_MISSING);
  });

  it('accepts a lock without datum when none is declared', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({}), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
  });

  it('still runs the amount check', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '1500000' }]);
    const r = validatePayment(d, scriptEntry({}), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INSUFFICIENT_AMOUNT);
  });
});

describe('validatePayment, script derived from code and parameters', () => {
  const core = jest.requireMock('@odatano/core') as {
    applyScriptParameters: jest.Mock;
    plutusScriptHash: jest.Mock;
  };
  const d = () => decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);

  beforeEach(() => {
    core.applyScriptParameters.mockReset().mockReturnValue('ccdd');
    core.plutusScriptHash.mockReset().mockReturnValue(SCRIPT_HASH);
  });

  it('applies the parameters in key order with the spec encoding, then hashes', () => {
    const r = validatePayment(d(), scriptEntry({
      scriptHash: undefined,
      script: { type: 'plutusV3', code: 'aabb' },
      parameters: {
        owner: { type: 'bytes', value: 'beef' },
        label: { type: 'string', value: 'hi' },
        limit: { type: 'bigint', value: 42 },
        open:  { type: 'boolean', value: true },
      },
    }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
    expect(core.applyScriptParameters).toHaveBeenCalledWith('aabb', [
      { bytes: 'beef' },
      { bytes: '6869' },
      { int: '42' },
      { constr: 1, fields: [] },
    ]);
    expect(core.plutusScriptHash).toHaveBeenCalledWith('ccdd', 'plutusV3');
  });

  it('hashes the code as is without parameters', () => {
    validatePayment(d(), scriptEntry({ scriptHash: undefined, script: { type: 'plutusV2', code: 'aabb' } }), { currentSlot: CURRENT_SLOT });
    expect(core.applyScriptParameters).not.toHaveBeenCalled();
    expect(core.plutusScriptHash).toHaveBeenCalledWith('aabb', 'plutusV2');
  });

  it('rejects when the derived hash is not the payTo credential', () => {
    core.plutusScriptHash.mockReturnValue(OTHER_SCRIPT_HASH);
    const r = validatePayment(d(), scriptEntry({ scriptHash: undefined, script: { type: 'plutusV3', code: 'aabb' } }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects when script and scriptHash disagree', () => {
    core.plutusScriptHash.mockReturnValue(OTHER_SCRIPT_HASH);
    const r = validatePayment(d(), scriptEntry({ script: { type: 'plutusV3', code: 'aabb' } }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not extra.scriptHash/);
  });

  it('rejects parameter types the spec gives no encoding for', () => {
    const r = validatePayment(d(), scriptEntry({
      scriptHash: undefined,
      script: { type: 'plutusV3', code: 'aabb' },
      parameters: { cfg: { type: 'map', value: {} } },
    }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type 'map' is not supported/);
  });

  it('rejects plutusV1 scripts', () => {
    const r = validatePayment(d(), scriptEntry({ scriptHash: undefined, script: { type: 'plutusV1', code: 'aabb' } }), { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.UNSUPPORTED_METHOD);
  });
});

describe('validatePayment, other transfer methods', () => {
  it('rejects masumi instead of treating it as a plain transfer', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const entry = { ...scriptEntry({}), extra: { assetTransferMethod: 'masumi' } } as unknown as PaymentRequirementEntry;
    const r = validatePayment(d, entry, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.UNSUPPORTED_METHOD);
  });

  it('sets no claim extra for a default transfer', () => {
    const d = decodedWith([{ address: SELLER_ADDR, lovelace: '2000000' }]);
    const entry: PaymentRequirementEntry = { ...scriptEntry({}), payTo: SELLER_ADDR, extra: { decimals: 6 } };
    const r = validatePayment(d, entry, { currentSlot: CURRENT_SLOT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claim.extra).toBeUndefined();
  });
});

describe('transfer method helpers', () => {
  it('treats a missing method as default', () => {
    expect(transferMethodOf({})).toBe('default');
    expect(transferMethodOf({ extra: { decimals: 6 } })).toBe('default');
    expect(transferMethodOf({ extra: { assetTransferMethod: 'script' } })).toBe('script');
  });

  it('supports default and script only', () => {
    expect(isSupportedTransferMethod('default')).toBe(true);
    expect(isSupportedTransferMethod('script')).toBe(true);
    expect(isSupportedTransferMethod('masumi')).toBe(false);
  });
});

describe('selectFirstSupported', () => {
  const masumi = { ...scriptEntry({}), extra: { assetTransferMethod: 'masumi' } } as unknown as PaymentRequirementEntry;
  const plain: PaymentRequirementEntry = { ...scriptEntry({}), payTo: SELLER_ADDR, extra: undefined };

  it('skips entries with unknown methods', () => {
    expect(selectFirstSupported([masumi, plain])).toBe(plain);
  });

  it('returns undefined when nothing is supported', () => {
    expect(selectFirstSupported([masumi])).toBeUndefined();
  });
});

describe('paymentCredentialOf', () => {
  it('reads key and script credentials', () => {
    expect(paymentCredentialOf(BUYER_ADDR)).toEqual({ kind: 'key', hashHex: BUYER_VKH });
    expect(paymentCredentialOf(SCRIPT_ADDR)).toEqual({ kind: 'script', hashHex: SCRIPT_HASH });
  });

  it('returns null for malformed input', () => {
    expect(paymentCredentialOf('not-bech32')).toBeNull();
  });
});
