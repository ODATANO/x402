/**
 * `x402Fetch`, drop-in fetch wrapper that auto-handles 402 responses.
 *
 * On a 402 response the wrapper:
 *   1. Parses the body as a v2 `PaymentRequirementsBody`.
 *   2. Picks an `accepts[]` entry (via `selectAccepts`, default = first).
 *   3. Calls the user's `pay` handler to get `{ signedTxCborHex, nonceRef }`.
 *   4. Encodes a `PAYMENT-SIGNATURE` envelope.
 *   5. Retries the original request with the header attached.
 *
 * Non-402 responses are passed through untouched. After `maxRetries`
 * payment attempts, the last response (whether 402 or other) is
 * returned to the caller, never an infinite loop.
 *
 * Native fetch is used by default (Node ≥18, all modern browsers).
 * Pass `opts.fetch` to override (testing, custom agents, etc.).
 */

import { encodePaymentEnvelope } from './envelope';
import { X402PaymentError, paymentErrorFromBody, unwrapCapEnvelope } from './errors';
import type { X402ClientOptions } from './types';
import type { PaymentRequirementsBody, PaymentRequirementEntry } from '../core/types';

type FetchFn = typeof globalThis.fetch;

export interface X402FetchOptions extends X402ClientOptions {
  /** Override the underlying fetch. Defaults to `globalThis.fetch`. */
  fetch?: FetchFn;
}

/**
 * Wrap `fetch` with 402-handling. The returned function has the same
 * signature as native fetch, so it's a drop-in replacement.
 */
export function x402Fetch(opts: X402FetchOptions): FetchFn {
  if (typeof opts?.pay !== 'function') {
    throw new TypeError('x402Fetch: opts.pay must be a function');
  }
  const baseFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new TypeError('x402Fetch: no fetch implementation available (Node ≥18 or pass opts.fetch)');
  }

  const maxRetries  = opts.maxRetries ?? 1;
  const selectFirst = (a: PaymentRequirementEntry[]) => a[0];
  const select      = opts.selectAccepts ?? selectFirst;

  return async function paidFetch(input, init) {
    let attemptsLeft = maxRetries;
    // Contextual typing from FetchFn means we don't need to spell out
    // RequestInfo / RequestInit explicitly, those are DOM-only globals.
    let nextInit = init;
    // Remember the last parsed 402 body so retries_exhausted carries
    // the same diagnostic shape as a fresh server_rejected.
    let lastBody: PaymentRequirementsBody | undefined;

    // Loop: original request + up-to-maxRetries payment retries.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await baseFetch(input, nextInit);
      if (res.status !== 402) return res;
      if (attemptsLeft <= 0) {
        if (opts.errorOnFailure) {
          // Use the last successfully-parsed 402 body if we have one
          // (we typically do, since the prior attempt parsed it). If
          // not, parse one more time to give the caller a useful error.
          let body = lastBody;
          if (!body) {
            try {
              const raw = await res.clone().json();
              body = unwrapCapEnvelope(raw) as PaymentRequirementsBody;
            } catch { /* fall through */ }
          }
          if (body) {
            throw paymentErrorFromBody(body, { kind: 'retries_exhausted', httpStatus: res.status });
          }
          throw new X402PaymentError({
            message:    'x402Fetch: retries exhausted with no parsable 402 body',
            kind:       'retries_exhausted',
            httpStatus: res.status,
          });
        }
        return res;
      }

      // Parse 402 body. If it's not a v2 PaymentRequirementsBody we
      // bail with the original response (or throw under errorOnFailure).
      // Some servers (CAP-gated ones using req.reject) wrap the v2 body
      // inside an OData error envelope, unwrap defensively before the
      // x402Version check.
      let body: PaymentRequirementsBody | undefined;
      try {
        const raw = await res.clone().json();
        body = unwrapCapEnvelope(raw) as PaymentRequirementsBody;
      } catch {
        if (opts.errorOnFailure) {
          throw new X402PaymentError({
            message:    'x402Fetch: 402 body was not JSON',
            kind:       'invalid_402_body',
            httpStatus: res.status,
          });
        }
        return res;
      }
      if (!body || body.x402Version !== 2 || !Array.isArray(body.accepts) || body.accepts.length === 0) {
        if (opts.errorOnFailure) {
          throw new X402PaymentError({
            message:    'x402Fetch: 402 body is not a v2 PaymentRequirementsBody',
            kind:       'invalid_402_body',
            httpStatus: res.status,
          });
        }
        return res;
      }
      lastBody = body;

      const chosen = select(body.accepts);
      if (!chosen) {
        if (opts.errorOnFailure) {
          throw paymentErrorFromBody(body, { kind: 'server_rejected', httpStatus: res.status });
        }
        return res;
      }

      // Invoke user's pay handler. Wallet rejection / signer errors /
      // network blips here all surface as X402PaymentError(pay_handler_failed)
      // with the original error on `.cause`, regardless of errorOnFailure.
      let payResult;
      try {
        payResult = await opts.pay(chosen);
      } catch (err) {
        throw new X402PaymentError({
          message: `x402Fetch: pay handler failed: ${(err as { message?: string })?.message ?? String(err)}`,
          kind:    'pay_handler_failed',
          accepts: body.accepts,
          cause:   err,
        });
      }
      const header = encodePaymentEnvelope({
        network:         chosen.network,
        signedTxCborHex: payResult.signedTxCborHex,
        nonceRef:        payResult.nonceRef,
      });

      // Merge PAYMENT-SIGNATURE into headers without mutating caller's init.
      const mergedHeaders = new Headers(nextInit?.headers ?? init?.headers);
      mergedHeaders.set('PAYMENT-SIGNATURE', header);
      nextInit = { ...(nextInit ?? init ?? {}), headers: mergedHeaders };

      attemptsLeft--;
    }
  };
}
