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
 *   - 'server_rejected'      , the server returned 402 with a structured
 *                              body. `code` carries the server's
 *                              canonical X402Code (e.g. `wrong_recipient`),
 *                              `serverError` carries the raw error string
 *                              for human display.
 *   - 'pay_handler_failed'   , the user-supplied `pay` callback threw
 *                              (wallet rejection, no funds, signer error,
 *                              etc). `cause` holds the original error.
 *   - 'retries_exhausted'    , the request was still 402 after
 *                              `maxRetries` payment attempts. Same shape
 *                              as `server_rejected` but indicates
 *                              repeated failure.
 *   - 'invalid_402_body'     , the server returned 402 but the body
 *                              wasn't a v2 PaymentRequirementsBody.
 *
 * The class is plain (no abstract methods, no fluent builders) so users
 * can construct it themselves if they're wrapping the wrappers.
 */

import type { PaymentRequirementEntry, PaymentRequirementsBody } from '../core/types';

export type X402PaymentErrorKind =
  | 'server_rejected'
  | 'retries_exhausted'
  | 'pay_handler_failed'
  | 'invalid_402_body';

export interface X402PaymentErrorInit {
  message: string;
  kind: X402PaymentErrorKind;
  /** Canonical X402Code from the server, when known. */
  code?: string;
  /** `accepts[]` from the 402 body, for the caller to retry against. */
  accepts?: PaymentRequirementEntry[];
  /** HTTP status code that triggered the error (usually 402). */
  httpStatus?: number;
  /** Verbatim `error` string from the 402 body, for human display. */
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
  readonly accepts?: PaymentRequirementEntry[];
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
 * Defensively unwrap a CAP / OData error envelope around a v2 body.
 *
 * Background: `gateService` in this package historically (≤ v0.2)
 * reaches a 402 via `req.reject(402, JSON.stringify(body))`, which
 * CAP wraps into its standard OData error shape, putting the canonical
 * v2 body inside `error.message` as a JSON string:
 *
 *   { "error": { "message": "{\"x402Version\":2, ... }", "code": "402", ... } }
 *
 * The Express middleware emits the v2 body at the top level directly.
 * This helper detects the CAP wrap and returns the unwrapped candidate
 * so client wrappers can validate v2 shape uniformly. Non-CAP bodies
 * pass through untouched.
 *
 * Symmetric server-side fix (emit canonical body even through CAP) is
 * a separate concern, deferred until we can validate the CAP-version
 * specific behaviour. The unwrap below keeps `x402Fetch` /
 * `x402Axios` working against both shapes.
 */
export function unwrapCapEnvelope(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const maybeError = (parsed as { error?: unknown }).error;
  if (!maybeError || typeof maybeError !== 'object') return parsed;
  const msg = (maybeError as { message?: unknown }).message;
  if (typeof msg !== 'string') return parsed;
  try {
    return JSON.parse(msg);
  } catch {
    return parsed;
  }
}

/**
 * Parse the (server, canonical) error string from a `PaymentRequirementsBody`.
 *
 * The middleware encodes failures as `"<base error> (<code>): <reason>"`
 * (see `cap.ts` / `express.ts`). We pull the code out so callers can
 * dispatch on it without re-parsing the wire string. The reason is
 * preserved in `.serverError`.
 *
 * Returns `undefined` when the body has no recognizable code (e.g. the
 * MISSING_HEADER path, where the middleware omits the parenthesised
 * suffix).
 */
export function parseErrorCode(serverError?: string): string | undefined {
  if (!serverError) return undefined;
  const m = serverError.match(/\(([a-z_]+)\)/);
  return m ? m[1] : undefined;
}

/**
 * Build an `X402PaymentError` from a parsed 402 body. `kind` defaults
 * to `server_rejected`; pass `'retries_exhausted'` when called after
 * the retry loop gave up.
 */
export function paymentErrorFromBody(
  body: PaymentRequirementsBody,
  init: {
    kind?: X402PaymentErrorKind;
    httpStatus?: number;
    cause?: unknown;
  } = {},
): X402PaymentError {
  const code = parseErrorCode(body.error);
  return new X402PaymentError({
    message:     body.error ?? 'payment required',
    kind:        init.kind ?? 'server_rejected',
    ...(code              !== undefined ? { code }                    : {}),
    accepts:     body.accepts,
    httpStatus:  init.httpStatus ?? 402,
    ...(body.error        !== undefined ? { serverError: body.error } : {}),
    ...(init.cause        !== undefined ? { cause: init.cause }       : {}),
  });
}
