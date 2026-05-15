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
 * Pure function, no chain calls, no I/O. Callable from any runtime
 * that has `Buffer` (Node) or a polyfill (browser bundlers usually
 * provide one via `buffer`).
 */

import type { Network } from '../core/network';
import type { PaymentEnvelope } from '../core/types';

const NONCE_RE = /^[0-9a-f]{64}#\d+$/i;
const HEX_RE   = /^[0-9a-f]+$/i;

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
      transaction: Buffer.from(args.signedTxCborHex, 'hex').toString('base64'),
      nonce:       args.nonceRef,
    },
  };

  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}
