/**
 * Client side of the x402 v2 HTTP transport: read `PAYMENT-REQUIRED` and
 * `PAYMENT-RESPONSE`, build `PAYMENT-SIGNATURE`. Pure and browser-safe.
 */

import { bytesToBase64, decodeBase64Json, encodeBase64Json } from '../core/base64';
import { Codes } from '../core/errors';
import { parseNonceRef } from '../core/nonce';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettlementResponse,
} from '../core/types';

const HEX_RE   = /^(?:[0-9a-f]{2})+$/i;

/** `PaymentRequired` from a `PAYMENT-REQUIRED` header value, or undefined. */
export function readPaymentRequired(header: string | null | undefined): PaymentRequired | undefined {
  const pr = decodeBase64Json(header) as PaymentRequired | null;
  return pr && pr.x402Version === 2 && Array.isArray(pr.accepts) && pr.resource ? pr : undefined;
}

/** `SettlementResponse` from a `PAYMENT-RESPONSE` header value, or undefined. */
export function readSettlement(header: string | null | undefined): SettlementResponse | undefined {
  const s = decodeBase64Json(header) as SettlementResponse | null;
  return s && typeof s.success === 'boolean' ? s : undefined;
}

/** True when the payment was broadcast but not yet confirmed: re-send the same header. */
export function isSettlementPending(s: SettlementResponse | undefined): boolean {
  return s?.success === false && s.errorReason === Codes.PENDING;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface EncodePaymentPayloadArgs {
  /** The 402 being answered; its `resource` and `extensions` are echoed. */
  paymentRequired: PaymentRequired;
  /** The chosen `accepts[]` entry, verbatim. */
  accepted: PaymentRequirements;
  /** Hex of the signed payment tx. */
  signedTxCborHex: string;
  /** `<txHash>#<outputIndex>` of a buyer UTxO the tx spends. */
  nonceRef: string;
}

/** The `PAYMENT-SIGNATURE` header value. Validates eagerly so a bad call fails here, not at the server. */
export function encodePaymentPayload(args: EncodePaymentPayloadArgs): string {
  if (typeof args.signedTxCborHex !== 'string' || !HEX_RE.test(args.signedTxCborHex)) {
    throw new TypeError('encodePaymentPayload: signedTxCborHex must be even-length hex');
  }
  if (!parseNonceRef(args.nonceRef)) {
    throw new TypeError(`encodePaymentPayload: nonceRef must be '<txHash>#<outputIndex>', got '${args.nonceRef}'`);
  }
  const payload: PaymentPayload = {
    x402Version: 2,
    resource:    args.paymentRequired.resource,
    accepted:    args.accepted,
    payload: {
      transaction: bytesToBase64(hexToBytes(args.signedTxCborHex)),
      nonce:       args.nonceRef,
    },
    ...(args.paymentRequired.extensions !== undefined ? { extensions: args.paymentRequired.extensions } : {}),
  };
  return encodeBase64Json(payload);
}
