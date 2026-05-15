import { decode } from '../../srv/core/decode';
import { X402Error, Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  FUTURE_SLOT,
  TEST_POLICY_ID, TEST_ASSET_NAME,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx, buildUnsigned } from '../fixtures/build-tx';
import { buildEnvelope, encodeRawEnvelope } from '../fixtures/envelope';

function happyPath() {
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: [
      { address: SELLER_ADDR, lovelace: '1000000' },
      { address: BUYER_ADDR,  lovelace: '8000000' },
    ],
    ttlSlot: FUTURE_SLOT,
  });
  return signTx(body, [BUYER_PRIV]);
}

describe('decode, happy path', () => {
  it('decodes a well-formed v2 envelope', () => {
    const signed = happyPath();
    const header = buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_REF });

    const d = decode(header);

    expect(d.envelope.x402Version).toBe(2);
    expect(d.envelope.scheme).toBe('exact');
    expect(d.envelope.network).toBe(NETWORK_PREPROD);
    expect(d.envelope.payload.nonce).toBe(NONCE_REF);
    expect(d.txHash).toBe(signed.txHash);
    expect(d.txCborHex).toBe(signed.cborHex);
    expect(d.outputs).toHaveLength(2);
    expect(d.inputs).toHaveLength(1);
    expect(d.inputs[0]!.txHash).toBe(NONCE_TX_HASH);
    expect(d.vkeyWitnessCount).toBe(1);
    expect(d.ttlSlot).toBe(FUTURE_SLOT);
    expect(d.nonce).toEqual({ txHash: NONCE_TX_HASH, index: NONCE_INDEX });
  });

  it('decodes native-asset outputs into the assets array', () => {
    const body = buildBody({
      inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
      outputs: [{
        address: SELLER_ADDR,
        lovelace: '1500000',
        assets: [{ policyId: TEST_POLICY_ID, nameHex: TEST_ASSET_NAME, qty: '42' }],
      }],
      ttlSlot: FUTURE_SLOT,
    });
    const signed = signTx(body, [BUYER_PRIV]);
    const header = buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_REF });

    const d = decode(header);
    expect(d.outputs[0]!.assets).toHaveLength(1);
    expect(d.outputs[0]!.assets[0]).toEqual({
      unit: (TEST_POLICY_ID + TEST_ASSET_NAME).toLowerCase(),
      policyId: TEST_POLICY_ID.toLowerCase(),
      assetNameHex: TEST_ASSET_NAME.toLowerCase(),
      quantity: '42',
    });
  });

  it('returns ttlSlot = null when the tx has no TTL', () => {
    const body = buildBody({
      inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    });
    const signed = signTx(body, [BUYER_PRIV]);
    const header = buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_REF });
    const d = decode(header);
    expect(d.ttlSlot).toBeNull();
  });

  it('returns vkeyWitnessCount = 0 for an unsigned tx', () => {
    const body = buildBody({
      inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    });
    const unsigned = buildUnsigned(body);
    const header = buildEnvelope({ txCborHex: unsigned.cborHex, nonceRef: NONCE_REF });
    const d = decode(header);
    expect(d.vkeyWitnessCount).toBe(0);
  });
});

describe('decode, error paths', () => {
  const expectThrow = (input: unknown, code: string) => {
    try { decode(input as string); }
    catch (e) {
      expect(e).toBeInstanceOf(X402Error);
      expect((e as X402Error).code).toBe(code);
      return;
    }
    throw new Error('expected X402Error to be thrown');
  };

  it('MISSING_HEADER for undefined / empty', () => {
    expectThrow(undefined, Codes.MISSING_HEADER);
    expectThrow('',        Codes.MISSING_HEADER);
    expectThrow(null,      Codes.MISSING_HEADER);
  });

  it('INVALID_BASE64 for malformed base64', () => {
    expectThrow('!@#$%^&*()',     Codes.INVALID_BASE64);
  });

  it('INVALID_JSON for valid base64 of non-JSON bytes', () => {
    expectThrow(Buffer.from('hello world', 'utf8').toString('base64'), Codes.INVALID_JSON);
  });

  it('MISSING_FIELD when scheme / network / payload missing', () => {
    expectThrow(encodeRawEnvelope({ x402Version: 2 }),                Codes.MISSING_FIELD);
    expectThrow(encodeRawEnvelope({ x402Version: 2, scheme: 'exact' }), Codes.MISSING_FIELD);
  });

  it('UNSUPPORTED_VERSION for v1 envelopes', () => {
    const signed = happyPath();
    expectThrow(buildEnvelope({
      txCborHex: signed.cborHex,
      nonceRef:  NONCE_REF,
      x402Version: 1,
    }), Codes.UNSUPPORTED_VERSION);
  });

  it('UNSUPPORTED_SCHEME for scheme other than exact', () => {
    const signed = happyPath();
    expectThrow(buildEnvelope({
      txCborHex: signed.cborHex,
      nonceRef:  NONCE_REF,
      scheme:    'upto',
    }), Codes.UNSUPPORTED_SCHEME);
  });

  it('MISSING_FIELD when payload.transaction missing', () => {
    expectThrow(encodeRawEnvelope({
      x402Version: 2, scheme: 'exact', network: NETWORK_PREPROD,
      payload: { nonce: NONCE_REF },
    }), Codes.MISSING_FIELD);
  });

  it('MISSING_FIELD when payload.nonce missing', () => {
    const signed = happyPath();
    expectThrow(encodeRawEnvelope({
      x402Version: 2, scheme: 'exact', network: NETWORK_PREPROD,
      payload: { transaction: Buffer.from(signed.cborHex, 'hex').toString('base64') },
    }), Codes.MISSING_FIELD);
  });

  it('INVALID_NONCE_FORMAT for malformed nonce', () => {
    const signed = happyPath();
    expectThrow(buildEnvelope({ txCborHex: signed.cborHex, nonceRef: 'not-a-nonce' }),
      Codes.INVALID_NONCE_FORMAT);
    expectThrow(buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_TX_HASH + '#-1' }),
      Codes.INVALID_NONCE_FORMAT);
  });

  it('INVALID_CBOR when payload.transaction is not a valid Cardano tx', () => {
    expectThrow(buildEnvelope({
      txCborHex: 'deadbeef',
      nonceRef:  NONCE_REF,
    }), Codes.INVALID_CBOR);
  });
});
