// decodePayment pulls in srv/bridge → @odatano/core; stub the barrel to its pure parser.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import { validatePayment } from '../../srv/core/validate';
import { transferMethodOf, isSupportedTransferMethod } from '../../srv/core/transfer-method';
import { selectFirstSupported } from '../../srv/client/select';
import { Codes } from '../../srv/core/errors';
import { decodePayment } from '../../srv/core/decode';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  SCRIPT_ADDR, SCRIPT_HASH, OTHER_SCRIPT_HASH,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, TTL_SLOT, MAX_TTL_SLOT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx, type TestOutput } from '../fixtures/build-tx';
import type { PaymentRequirements, ScriptTransferExtra } from '../../srv/core/types';

const DATUM = 'd8799f182aff';

function decodedWith(outputs: TestOutput[]) {
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs,
    ttlSlot: TTL_SLOT,
  });
  const signed = signTx(body, [BUYER_PRIV]);
  return decodePayment({
    x402Version: 2,
    accepted: scriptEntry({}),
    payload: { transaction: Buffer.from(signed.cborHex, 'hex').toString('base64'), nonce: NONCE_REF },
  });
}

const OPTS = { currentSlot: CURRENT_SLOT, maxTtlSlot: MAX_TTL_SLOT };

/** Hand-built so tests can carry extras `buildRequirements` would refuse. */
function scriptEntry(extra: Partial<ScriptTransferExtra>, payTo: string = SCRIPT_ADDR): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK_PREPROD,
    asset: 'lovelace',
    amount: '2000000',
    payTo,
    maxTimeoutSeconds: 600,
    extra: { assetTransferMethod: 'script', scriptHash: SCRIPT_HASH, ...extra },
  };
}

describe('validatePayment, script transfer', () => {
  it('accepts a lock at the declared script and reports the locked UTxO', () => {
    const d = decodedWith([
      { address: BUYER_ADDR, lovelace: '1000000' },
      { address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: DATUM },
    ]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.match.extra).toEqual({ assetTransferMethod: 'script', lockRefs: [`${d.txHash}#1`] });
    }
  });

  it('rejects when payTo is not the address of scriptHash', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({ scriptHash: OTHER_SCRIPT_HASH }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects when payTo is a key address', () => {
    const d = decodedWith([{ address: SELLER_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({}, SELLER_ADDR), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects when neither scriptHash nor script is declared', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({ scriptHash: undefined }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects a lock whose datum differs from extra.datum', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: 'd8799f182bff' }]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.DATUM_MISMATCH);
  });

  it('requires the datum on the output that carries the payment', () => {
    // Output 0 pays the amount without datum; output 1 carries the datum with min-ADA only.
    const d = decodedWith([
      { address: SCRIPT_ADDR, lovelace: '2000000' },
      { address: SCRIPT_ADDR, lovelace: '1000000', inlineDatumHex: DATUM },
    ]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.DATUM_MISSING);
  });

  it('takes the claimed amount from the paying output that carries the datum', () => {
    const d = decodedWith([
      { address: SCRIPT_ADDR, lovelace: '5000000' },
      { address: SCRIPT_ADDR, lovelace: '2500000', inlineDatumHex: DATUM },
    ]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.amountUnits).toBe('2500000');
  });

  it('compares the datum as PlutusData, not byte for byte', () => {
    // Same constr 0 [42], declared with a definite-length list.
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000', inlineDatumHex: DATUM }]);
    const r = validatePayment(d, scriptEntry({ datum: 'd87981182a' }), OPTS);
    expect(r.ok).toBe(true);
  });

  it('rejects when extra.datum is set but the lock carries no inline datum', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({ datum: DATUM }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.DATUM_MISSING);
  });

  it('accepts a lock without datum when none is declared', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const r = validatePayment(d, scriptEntry({}), OPTS);
    expect(r.ok).toBe(true);
  });

  it('still runs the amount check', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '1500000' }]);
    const r = validatePayment(d, scriptEntry({}), OPTS);
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
  // The derived hash is cached per script and parameters, so every test uses its own script code.

  beforeEach(() => {
    core.applyScriptParameters.mockReset().mockReturnValue('ccdd');
    core.plutusScriptHash.mockReset().mockReturnValue(SCRIPT_HASH);
  });

  it('applies the parameters in key order with the spec encoding, then hashes', () => {
    const r = validatePayment(d(), scriptEntry({
      scriptHash: undefined,
      script: { type: 'plutusV3', code: 'aa01' },
      parameters: {
        owner: { type: 'bytes', value: 'beef' },
        label: { type: 'string', value: 'hi' },
        limit: { type: 'bigint', value: 42 },
        open:  { type: 'boolean', value: true },
      },
    }), OPTS);
    expect(r.ok).toBe(true);
    expect(core.applyScriptParameters).toHaveBeenCalledWith('aa01', [
      { bytes: 'beef' },
      { bytes: '6869' },
      { int: '42' },
      { constr: 1, fields: [] },
    ]);
    expect(core.plutusScriptHash).toHaveBeenCalledWith('ccdd', 'plutusV3');
  });

  it('hashes the code as is without parameters', () => {
    validatePayment(d(), scriptEntry({ scriptHash: undefined, script: { type: 'plutusV2', code: 'aa02' } }), OPTS);
    expect(core.applyScriptParameters).not.toHaveBeenCalled();
    expect(core.plutusScriptHash).toHaveBeenCalledWith('aa02', 'plutusV2');
  });

  it('rejects when the derived hash is not the payTo credential', () => {
    core.plutusScriptHash.mockReturnValue(OTHER_SCRIPT_HASH);
    const r = validatePayment(d(), scriptEntry({ scriptHash: undefined, script: { type: 'plutusV3', code: 'aa03' } }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
  });

  it('rejects when script and scriptHash disagree', () => {
    core.plutusScriptHash.mockReturnValue(OTHER_SCRIPT_HASH);
    const r = validatePayment(d(), scriptEntry({ script: { type: 'plutusV3', code: 'aa04' } }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not extra.scriptHash/);
  });

  it('rejects parameter types the spec gives no encoding for', () => {
    const r = validatePayment(d(), scriptEntry({
      scriptHash: undefined,
      script: { type: 'plutusV3', code: 'aa05' },
      parameters: { cfg: { type: 'map', value: {} } },
    }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type 'map' is not supported/);
  });

  it('rejects plutusV1 scripts', () => {
    const r = validatePayment(d(), scriptEntry({ scriptHash: undefined, script: { type: 'plutusV1', code: 'aa06' } }), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.UNSUPPORTED_METHOD);
  });

  it('derives the hash once for the same script and parameters', () => {
    const entry = () => scriptEntry({
      scriptHash: undefined,
      script: { type: 'plutusV3', code: 'bb01' },
      parameters: { limit: { type: 'bigint', value: 7 } },
    });
    expect(validatePayment(d(), entry(), OPTS).ok).toBe(true);
    expect(validatePayment(d(), entry(), OPTS).ok).toBe(true);
    expect(core.applyScriptParameters).toHaveBeenCalledTimes(1);
    expect(core.plutusScriptHash).toHaveBeenCalledTimes(1);
  });

  it('derives the hash again for other parameters, another type or another code', () => {
    const entry = (code: string, type: 'plutusV2' | 'plutusV3', limit: number) => scriptEntry({
      scriptHash: undefined,
      script: { type, code },
      parameters: { limit: { type: 'bigint', value: limit } },
    });
    validatePayment(d(), entry('bb02', 'plutusV3', 1), OPTS);
    validatePayment(d(), entry('bb02', 'plutusV3', 2), OPTS);
    validatePayment(d(), entry('bb02', 'plutusV2', 2), OPTS);
    validatePayment(d(), entry('bb03', 'plutusV2', 2), OPTS);
    expect(core.plutusScriptHash).toHaveBeenCalledTimes(4);
    validatePayment(d(), entry('bb02', 'plutusV3', 1), OPTS);
    expect(core.plutusScriptHash).toHaveBeenCalledTimes(4);
  });

  it('does not keep a derivation that failed', () => {
    core.plutusScriptHash.mockImplementationOnce(() => { throw new Error('not a script'); });
    const entry = () => scriptEntry({ scriptHash: undefined, script: { type: 'plutusV3', code: 'bb04' } });
    const first = validatePayment(d(), entry(), OPTS);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.code).toBe(Codes.SCRIPT_ADDRESS_MISMATCH);
    expect(validatePayment(d(), entry(), OPTS).ok).toBe(true);
    expect(core.plutusScriptHash).toHaveBeenCalledTimes(2);
  });
});

describe('validatePayment, other transfer methods', () => {
  it('rejects masumi instead of treating it as a plain transfer', () => {
    const d = decodedWith([{ address: SCRIPT_ADDR, lovelace: '2000000' }]);
    const entry = { ...scriptEntry({}), extra: { assetTransferMethod: 'masumi' } } as unknown as PaymentRequirements;
    const r = validatePayment(d, entry, OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.UNSUPPORTED_METHOD);
  });

  it('sets no claim extra for a default transfer', () => {
    const d = decodedWith([{ address: SELLER_ADDR, lovelace: '2000000' }]);
    const entry: PaymentRequirements = { ...scriptEntry({}), payTo: SELLER_ADDR, extra: { decimals: 6 } };
    const r = validatePayment(d, entry, OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.match.extra).toBeUndefined();
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
  const masumi = { ...scriptEntry({}), extra: { assetTransferMethod: 'masumi' } } as unknown as PaymentRequirements;
  const plain: PaymentRequirements = { ...scriptEntry({}), payTo: SELLER_ADDR, extra: undefined };

  it('skips entries with unknown methods', () => {
    expect(selectFirstSupported([masumi, plain])).toBe(plain);
  });

  it('returns undefined when nothing is supported', () => {
    expect(selectFirstSupported([masumi])).toBeUndefined();
  });

  it('skips entries with a payment flow other than authorization', () => {
    const upfront: PaymentRequirements = { ...plain, extra: { paymentFlow: 'upfront' } };
    const authorization: PaymentRequirements = { ...plain, extra: { paymentFlow: 'authorization' } };
    expect(selectFirstSupported([upfront, authorization])).toBe(authorization);
    expect(selectFirstSupported([upfront])).toBeUndefined();
  });
});
