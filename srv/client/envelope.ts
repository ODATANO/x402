/**
 * Build the `PAYMENT-SIGNATURE` header value for a Cardano-x402-v2 retry.
 *
 * Inverse of `srv/core/decode.ts`. The wire format is:
 *
 *   PAYMENT-SIGNATURE: base64(JSON.stringify({
 *     x402Version: 2,
 *     scheme: 'exact',
 *     network: 'cardano:preprod' | 'cardano:mainnet' | 'cardano:preview',
 *     payload: {
 *       transaction: '<base64 CBOR of signed tx>',
 *       nonce:       '<txHash>#<outputIndex>'
 *     }
 *   }))
 *
 * Pure function, no chain calls, no I/O. Runtime-neutral: uses `Buffer`
 * where available (Node) and falls back to `btoa` (browsers), so
 * bundlers need no Buffer polyfill.
 */

import type { Network } from '../core/network';
import type { PaymentEnvelope } from '../core/types';

const NONCE_RE = /^[0-9a-f]{64}#\d+$/i;
const HEX_RE   = /^[0-9a-f]+$/i;

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  // Browser path: build a binary string in chunks (spread has arg limits).
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface EncodeEnvelopeArgs {
  network: Network;
  /** Hex of the SIGNED payment tx (vkey witnesses already attached). */
  signedTxCborHex: string;
  /** `<txHash>#<outputIndex>` UTxO-ref nonce. */
  nonceRef: string;
}

/**
 * Encode the v2 PAYMENT-SIGNATURE envelope. Validates shape eagerly so
 * a malformed call fails here, not on the server's `decode()`.
 */
export function encodePaymentEnvelope(args: EncodeEnvelopeArgs): string {
  if (!args.network) {
    throw new TypeError('encodePaymentEnvelope: network is required');
  }
  if (typeof args.signedTxCborHex !== 'string' || !HEX_RE.test(args.signedTxCborHex)) {
    throw new TypeError('encodePaymentEnvelope: signedTxCborHex must be a hex string');
  }
  if (args.signedTxCborHex.length % 2 !== 0) {
    throw new TypeError('encodePaymentEnvelope: signedTxCborHex has odd length');
  }
  if (!NONCE_RE.test(args.nonceRef)) {
    throw new TypeError(
      `encodePaymentEnvelope: nonceRef must be '<txHash>#<outputIndex>' (64-hex#int), got '${args.nonceRef}'`,
    );
  }

  const envelope: PaymentEnvelope = {
    x402Version: 2,
    scheme:      'exact',
    network:     args.network,
    payload: {
      transaction: bytesToBase64(hexToBytes(args.signedTxCborHex)),
      nonce:       args.nonceRef,
    },
  };

  return bytesToBase64(new TextEncoder().encode(JSON.stringify(envelope)));
}
