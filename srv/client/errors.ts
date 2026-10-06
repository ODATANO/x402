/**
 * Typed client-side errors thrown by `x402Fetch` / `x402Axios`.
 *
 * The server-side `X402Error` (in `srv/core/errors.ts`) is a different
 * class with a different purpose: it's thrown inside the decode +
 * validate pipeline and carries one of the canonical `X402Code` values.
 *
 * `X402PaymentError` here is the client-facing analog: it surfaces in
 * caller code (browser, CLI, server-to-server) when a payment attempt
 * cannot complete. Callers can `instanceof`-check or pattern-match on
 * `.kind` to distinguish:
 *
 *   - 'server_rejected'          , the server answered 402. `code` carries the
 *                                  reason code (e.g.
 *                                  `invalid_exact_cardano_payload_recipient_mismatch`),
 *                                  `serverError` the raw error string.
 *   - 'pay_handler_failed'       , the user-supplied `pay` callback threw
 *                                  (wallet rejection, no funds, signer error).
 *                                  `cause` holds the original error.
 *   - 'retries_exhausted'        , still 402 after `maxRetries` payments.
 *   - 'invalid_payment_required' , the 402 carried no valid `PAYMENT-REQUIRED` header.
 *   - 'settlement_pending'       , the payment was broadcast (`PAYMENT-RESPONSE`
 *                                  `settlement_pending`) but not confirmed within
 *                                  `pendingRetries` re-sends. The buyer HAS paid;
 *                                  retry the same request later, do not pay again.
 *
 * The class is plain (no abstract methods, no fluent builders) so users
 * can construct it themselves if they're wrapping the wrappers.
 */

import type { PaymentRequired, PaymentRequirements, SettlementResponse } from '../core/types';

export type X402PaymentErrorKind =
  | 'server_rejected'
  | 'retries_exhausted'
  | 'pay_handler_failed'
  | 'invalid_payment_required'
  | 'settlement_pending';

export interface X402PaymentErrorInit {
  message: string;
  kind: X402PaymentErrorKind;
  /** Reason code from the server, when known. */
  code?: string;
  /** `accepts[]` of the 402, for the caller to retry against. */
  accepts?: PaymentRequirements[];
  /** `PAYMENT-RESPONSE` of the failed settlement, when the server sent one. */
  settlement?: SettlementResponse;
  /** HTTP status code that triggered the error (usually 402). */
  httpStatus?: number;
  /** Verbatim `error` string of the `PaymentRequired`, for human display. */
  serverError?: string;
  /** Wrapped underlying error (wallet rejection, axios error, etc.). */
  cause?: unknown;
}

/**
 * Thrown by `x402Fetch` and `x402Axios` when a payment attempt fails or
 * is exhausted.
 *
 * `instanceof X402PaymentError` is the reliable runtime check; the
 * `.kind` field is the discriminator for switching on cause.
 */
export class X402PaymentError extends Error {
  readonly kind: X402PaymentErrorKind;
  readonly code?: string;
  readonly accepts?: PaymentRequirements[];
  readonly settlement?: SettlementResponse;
  readonly httpStatus?: number;
  readonly serverError?: string;
  // Override Error's `cause` typing, ours is `unknown` to allow any value.
  override readonly cause?: unknown;

  constructor(init: X402PaymentErrorInit) {
    super(init.message);
    this.name = 'X402PaymentError';
    this.kind = init.kind;
    if (init.code        !== undefined) this.code        = init.code;
    if (init.accepts     !== undefined) this.accepts     = init.accepts;
    if (init.settlement  !== undefined) this.settlement  = init.settlement;
    if (init.httpStatus  !== undefined) this.httpStatus  = init.httpStatus;
    if (init.serverError !== undefined) this.serverError = init.serverError;
    if (init.cause       !== undefined) this.cause       = init.cause;
    // V8: keep stack trace pointing at caller, not constructor.
    if (typeof (Error as unknown as { captureStackTrace?: (target: object, ctor: unknown) => void }).captureStackTrace === 'function') {
      (Error as unknown as { captureStackTrace: (target: object, ctor: unknown) => void })
        .captureStackTrace(this, X402PaymentError);
    }
  }
}

/**
 * Reason code inside a `PaymentRequired.error` string. The middleware
 * writes `"payment rejected (<code>): <reason>"`; undefined when the
 * string carries no code (the plain "header is required" 402).
 */
export function parseErrorCode(serverError?: string): string | undefined {
  if (!serverError) return undefined;
  const m = serverError.match(/\(([a-z0-9_]+)\)/);
  return m ? m[1] : undefined;
}

/** `X402PaymentError` from a 402: its `PaymentRequired` and, after a failed settle, its `PAYMENT-RESPONSE`. */
export function paymentErrorFrom(
  paymentRequired: PaymentRequired | undefined,
  init: {
    kind?: X402PaymentErrorKind;
    httpStatus?: number;
    settlement?: SettlementResponse;
    cause?: unknown;
  } = {},
): X402PaymentError {
  const serverError = paymentRequired?.error;
  const code = init.settlement?.errorReason ?? parseErrorCode(serverError);
  return new X402PaymentError({
    message:    serverError ?? init.settlement?.errorReason ?? 'payment required',
    kind:       init.kind ?? 'server_rejected',
    ...(code !== undefined ? { code } : {}),
    ...(paymentRequired ? { accepts: paymentRequired.accepts } : {}),
    ...(init.settlement ? { settlement: init.settlement } : {}),
    httpStatus: init.httpStatus ?? 402,
    ...(serverError !== undefined ? { serverError } : {}),
    ...(init.cause !== undefined ? { cause: init.cause } : {}),
  });
}
