/**
 * Parse and shape-check the `PAYMENT-SIGNATURE` header (x402 v2
 * `PaymentPayload`, Cardano `exact` payload). Pure, no chain calls.
 * Throws `X402Error`; every code here is a malformed payload (HTTP 400).
 */

import { decodeBase64Json } from './base64';
import { X402Error, Codes } from './errors';
import { normalizeNetwork } from './network';
import { parseNonceRef } from './nonce';
import type { PaymentPayload } from './types';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parsePaymentPayload(header: string | undefined | null): PaymentPayload {
  if (!header) throw new X402Error(Codes.MISSING_HEADER, 'PAYMENT-SIGNATURE header is required');
  const raw = decodeBase64Json(header);
  if (!isObject(raw)) {
    throw new X402Error(Codes.INVALID_PAYLOAD, 'PAYMENT-SIGNATURE is not base64-encoded JSON');
  }
  return checkPaymentPayload(raw);
}

/** Shape check of a `PaymentPayload` received as JSON (header or facilitator request). */
export function checkPaymentPayload(raw: unknown): PaymentPayload {
  if (!isObject(raw)) throw new X402Error(Codes.INVALID_PAYLOAD, 'paymentPayload must be an object');
  if (raw.x402Version !== 2) {
    throw new X402Error(Codes.UNSUPPORTED_VERSION, `x402Version ${String(raw.x402Version)} is not supported (only 2)`);
  }

  const accepted = raw.accepted;
  if (!isObject(accepted)) throw new X402Error(Codes.INVALID_PAYLOAD, 'accepted is required');
  if (accepted.scheme !== 'exact') {
    throw new X402Error(Codes.UNSUPPORTED_SCHEME, `scheme '${String(accepted.scheme)}' is not supported (only 'exact')`);
  }
  if (!normalizeNetwork(accepted.network)) {
    throw new X402Error(Codes.INVALID_NETWORK_FORMAT, `network '${String(accepted.network)}' is not a Cardano network`);
  }
  for (const f of ['asset', 'amount', 'payTo'] as const) {
    if (typeof accepted[f] !== 'string') throw new X402Error(Codes.INVALID_PAYLOAD, `accepted.${f} is required`);
  }
  if (typeof accepted.maxTimeoutSeconds !== 'number') {
    throw new X402Error(Codes.INVALID_PAYLOAD, 'accepted.maxTimeoutSeconds is required');
  }
  if (accepted.extra !== undefined && !isObject(accepted.extra)) {
    throw new X402Error(Codes.INVALID_PAYLOAD, 'accepted.extra must be an object');
  }

  const payload = raw.payload;
  if (!isObject(payload) || typeof payload.transaction !== 'string' || payload.transaction.length === 0) {
    throw new X402Error(Codes.INVALID_PAYLOAD, 'payload.transaction is required');
  }
  if (!parseNonceRef(payload.nonce)) {
    throw new X402Error(Codes.INVALID_NONCE_FORMAT, "payload.nonce must be '<txHash>#<outputIndex>'");
  }
  if (raw.resource !== undefined && (!isObject(raw.resource) || typeof raw.resource.url !== 'string')) {
    throw new X402Error(Codes.INVALID_PAYLOAD, 'resource must be an object with url');
  }
  if (raw.extensions !== undefined && !isObject(raw.extensions)) {
    throw new X402Error(Codes.INVALID_PAYLOAD, 'extensions must be an object');
  }

  return raw as unknown as PaymentPayload;
}
