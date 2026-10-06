/**
 * Build `PAYMENT-SIGNATURE` values (x402 v2 `PaymentPayload`) for tests.
 * The base64 must be canonical: `parsePaymentPayload` rejects anything else.
 */

import type { PaymentRequirements, ResourceInfo } from '../../srv/core/types';

export interface PaymentSignatureArgs {
  /** The `accepts[]` entry the buyer pays, verbatim. */
  accepted: PaymentRequirements;
  txCborHex: string;
  /** '<txHash>#<index>' */
  nonceRef: string;
  resource?: ResourceInfo;
  extensions?: Record<string, unknown>;
  /** Top-level fields to add or replace, for corruption tests. */
  overrides?: Record<string, unknown>;
}

export function buildPaymentSignature(args: PaymentSignatureArgs): string {
  const payload = {
    x402Version: 2,
    ...(args.resource ? { resource: args.resource } : {}),
    accepted: args.accepted,
    payload: {
      transaction: Buffer.from(args.txCborHex, 'hex').toString('base64'),
      nonce:       args.nonceRef,
    },
    ...(args.extensions ? { extensions: args.extensions } : {}),
    ...args.overrides,
  };
  return encodeRawPayload(payload);
}

/** Encode any JSON value as a `PAYMENT-SIGNATURE` (or other x402 header) value. */
export function encodeRawPayload(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Decode a base64 JSON header value. */
export function decodeHeader<T = unknown>(value: string | undefined | null): T {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8')) as T;
}
