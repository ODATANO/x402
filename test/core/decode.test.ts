// Stub the @odatano/core barrel down to its pure parser so bridge.ts's
// top-level require() doesn't drag in uncompiled @cds-models .ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import * as bridge from '../../srv/bridge';
import { decodePayment } from '../../srv/core/decode';
import { X402Error, Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  TTL_SLOT,
  TEST_POLICY_ID, TEST_ASSET_NAME, TEST_ASSET_UNIT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx, buildUnsigned, type TestOutput } from '../fixtures/build-tx';
import type { PaymentPayload, PaymentRequirements } from '../../srv/core/types';

const accepted: PaymentRequirements = {
  scheme: 'exact', network: NETWORK_PREPROD, asset: 'lovelace', amount: '1000000',
  payTo: SELLER_ADDR, maxTimeoutSeconds: 600,
};

function payloadFor(txCborHex: string, nonce = NONCE_REF): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: { transaction: Buffer.from(txCborHex, 'hex').toString('base64'), nonce },
  };
}

function signed(outputs: TestOutput[], extra: { ttlSlot?: number; validityStartSlot?: number } = { ttlSlot: TTL_SLOT }) {
  return signTx(buildBody({ inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }], outputs, ...extra }), [BUYER_PRIV]);
}

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (e) { return (e as X402Error).code; }
}

describe('decodePayment', () => {
  it('decodes the signed transaction of a payload', () => {
    const tx = signed([
      { address: SELLER_ADDR, lovelace: '1000000' },
      { address: BUYER_ADDR,  lovelace: '8000000' },
    ]);
    const payload = payloadFor(tx.cborHex);
    const d = decodePayment(payload);

    expect(d.payload).toBe(payload);
    expect(d.txHash).toBe(tx.txHash);
    expect(d.txCborHex).toBe(tx.cborHex);
    expect(d.outputs.map(o => o.outputIndex)).toEqual([0, 1]);
    expect(d.inputs).toEqual([{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }]);
    expect(d.vkeyWitnessCount).toBe(1);
    expect(d.ttlSlot).toBe(TTL_SLOT);
    expect(d.validityStartSlot).toBeNull();
    expect(d.mint).toEqual([]);
    expect(d.fee).toBe('200000');
    expect(d.nonce).toEqual({ txHash: NONCE_TX_HASH, index: NONCE_INDEX });
    expect(d.isValid).toBe(true);
  });

  it('splits native-asset units into policy and name', () => {
    const d = decodePayment(payloadFor(signed([{
      address: SELLER_ADDR, lovelace: '1500000',
      assets: [{ policyId: TEST_POLICY_ID, nameHex: TEST_ASSET_NAME, qty: '42' }],
    }]).cborHex));
    expect(d.outputs[0]!.assets).toEqual([{
      unit: TEST_ASSET_UNIT, policyId: TEST_POLICY_ID, assetNameHex: TEST_ASSET_NAME, quantity: '42',
    }]);
  });

  it('passes the inline datum through', () => {
    const d = decodePayment(payloadFor(signed([
      { address: SELLER_ADDR, lovelace: '2000000', inlineDatumHex: 'd8799f182aff' },
      { address: BUYER_ADDR, lovelace: '1000000' },
    ]).cborHex));
    expect(d.outputs[0]!.inlineDatumHex).toBe('d8799f182aff');
    expect(d.outputs[1]!.inlineDatumHex).toBeNull();
  });

  it('reads the validity range and an absent TTL', () => {
    const d = decodePayment(payloadFor(signed([{ address: SELLER_ADDR, lovelace: '1000000' }], { validityStartSlot: 7 }).cborHex));
    expect(d.ttlSlot).toBeNull();
    expect(d.validityStartSlot).toBe(7);
  });

  it('counts zero witnesses on an unsigned tx', () => {
    const body = buildBody({ inputs: [{ txHash: NONCE_TX_HASH, outputIndex: 0 }], outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }] });
    expect(decodePayment(payloadFor(buildUnsigned(body).cborHex)).vkeyWitnessCount).toBe(0);
  });

  it('rejects a transaction that is not base64', () => {
    const p = payloadFor('00');
    p.payload.transaction = '%%%';
    expect(codeOf(() => decodePayment(p))).toBe(Codes.INVALID_CBOR);
  });

  it('rejects bytes that are not a Cardano transaction', () => {
    expect(codeOf(() => decodePayment(payloadFor('deadbeef')))).toBe(Codes.INVALID_CBOR);
  });

  it('rejects a nonce output index above 65535', () => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    expect(codeOf(() => decodePayment(payloadFor(tx.cborHex, `${NONCE_TX_HASH}#70000`)))).toBe(Codes.INVALID_NONCE_FORMAT);
  });

  it.each([
    ['no index', NONCE_TX_HASH],
    ['a short hash', `${'ab'.repeat(31)}#0`],
    ['a non-hex hash', `${'zz'.repeat(32)}#0`],
    ['a negative index', `${NONCE_TX_HASH}#-1`],
    ['an empty string', ''],
  ])('rejects a nonce with %s', (_label, nonce) => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    expect(codeOf(() => decodePayment(payloadFor(tx.cborHex, nonce)))).toBe(Codes.INVALID_NONCE_FORMAT);
  });

  it('lower-cases the nonce hash', () => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    const d = decodePayment(payloadFor(tx.cborHex, `${NONCE_TX_HASH.toUpperCase()}#${NONCE_INDEX}`));
    expect(d.nonce).toEqual({ txHash: NONCE_TX_HASH, index: NONCE_INDEX });
  });
});

describe('decodePayment, parser fields', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes mint and output cborSize through', () => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    const real = bridge.parseTransaction(tx.cborHex);
    jest.spyOn(bridge, 'parseTransaction').mockReturnValue({
      ...real,
      mint:    [{ unit: TEST_ASSET_UNIT.toUpperCase(), quantity: '-3' }],
      outputs: real.outputs.map(o => ({ ...o, cborSize: 61 })),
    });
    const d = decodePayment(payloadFor(tx.cborHex));
    expect(d.mint).toEqual([{ unit: TEST_ASSET_UNIT, policyId: TEST_POLICY_ID, assetNameHex: TEST_ASSET_NAME, quantity: '-3' }]);
    expect(d.outputs[0]!.cborSize).toBe(61);
  });

  it('is not valid when the parser reports isValid false', () => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    const real = bridge.parseTransaction(tx.cborHex);
    jest.spyOn(bridge, 'parseTransaction').mockReturnValue({ ...real, isValid: false });
    expect(decodePayment(payloadFor(tx.cborHex)).isValid).toBe(false);
  });

  it('is not valid when the parser does not report the flag', () => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    const { isValid: _dropped, ...unreported } = bridge.parseTransaction(tx.cborHex);
    jest.spyOn(bridge, 'parseTransaction').mockReturnValue(unreported as ReturnType<typeof bridge.parseTransaction>);
    expect(_dropped).toBe(true);
    expect(decodePayment(payloadFor(tx.cborHex)).isValid).toBe(false);
  });

  it('reports the output size the parser measures', () => {
    const d = decodePayment(payloadFor(signed([{ address: SELLER_ADDR, lovelace: '1000000' }]).cborHex));
    expect(d.outputs[0]!.cborSize).toBeGreaterThan(0);
  });

  it('omits cborSize when the parser does not report it', () => {
    const tx = signed([{ address: SELLER_ADDR, lovelace: '1000000' }]);
    const real = bridge.parseTransaction(tx.cborHex);
    jest.spyOn(bridge, 'parseTransaction').mockReturnValue({
      ...real,
      outputs: real.outputs.map(o => { const copy = { ...o }; delete copy.cborSize; return copy; }),
    });
    expect(decodePayment(payloadFor(tx.cborHex)).outputs[0]).not.toHaveProperty('cborSize');
  });
});
