/**
 * `encodePaymentEnvelope` is the inverse of `srv/core/decode.ts`. The
 * critical assertion is the roundtrip, anything `encodePaymentEnvelope`
 * produces must be accepted by `decode()` with all fields preserved.
 */

import { encodePaymentEnvelope } from '../../srv/client/envelope';
import { decode } from '../../srv/core/decode';
import { buildBody, signTx } from '../fixtures/build-tx';
import {
  BUYER_PRIV,
  SELLER_ADDR,
  NONCE_TX_HASH,
  NONCE_REF,
  NETWORK_PREPROD,
} from '../fixtures/constants';

function buildSignedTx() {
  const body = buildBody({
    inputs:  [{ txHash: NONCE_TX_HASH, outputIndex: 0 }],
    outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    ttlSlot: 80_000_500,
  });
  return signTx(body, [BUYER_PRIV]);
}

describe('encodePaymentEnvelope', () => {
  it('produces a header that decode() parses back to the same fields', () => {
    const signed = buildSignedTx();
    const header = encodePaymentEnvelope({
      network:         NETWORK_PREPROD,
      signedTxCborHex: signed.cborHex,
      nonceRef:        NONCE_REF,
    });

    const decoded = decode(header);
    expect(decoded.envelope.network).toBe(NETWORK_PREPROD);
    expect(decoded.envelope.scheme).toBe('exact');
    expect(decoded.envelope.x402Version).toBe(2);
    expect(decoded.envelope.payload.nonce).toBe(NONCE_REF);
    expect(decoded.txHash).toBe(signed.txHash);
    expect(decoded.nonce.txHash).toBe(NONCE_TX_HASH.toLowerCase());
    expect(decoded.nonce.index).toBe(0);
  });

  it('rejects non-hex CBOR', () => {
    expect(() => encodePaymentEnvelope({
      network:         NETWORK_PREPROD,
      signedTxCborHex: 'not-hex!',
      nonceRef:        NONCE_REF,
    })).toThrow(/hex string/);
  });

  it('rejects odd-length CBOR hex', () => {
    expect(() => encodePaymentEnvelope({
      network:         NETWORK_PREPROD,
      signedTxCborHex: 'ab1',
      nonceRef:        NONCE_REF,
    })).toThrow(/odd length/);
  });

  it('rejects malformed nonceRef', () => {
    expect(() => encodePaymentEnvelope({
      network:         NETWORK_PREPROD,
      signedTxCborHex: 'aabb',
      nonceRef:        'not-a-nonce',
    })).toThrow(/nonceRef/);
  });

  it('rejects missing network', () => {
    expect(() => encodePaymentEnvelope({
      network:         '' as never,
      signedTxCborHex: 'aabb',
      nonceRef:        NONCE_REF,
    })).toThrow(/network/);
  });
});
