/**
 * `x402Fetch` — drop-in fetch wrapper that auto-handles 402 responses.
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
 * returned to the caller — never an infinite loop.
 *
 * Native fetch is used by default (Node ≥18, all modern browsers).
 * Pass `opts.fetch` to override (testing, custom agents, etc.).
 */

import { encodePaymentEnvelope } from './envelope';
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
    // RequestInfo / RequestInit explicitly — those are DOM-only globals.
    let nextInit = init;

    // Loop: original request + up-to-maxRetries payment retries.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await baseFetch(input, nextInit);
      if (res.status !== 402 || attemptsLeft <= 0) return res;

      // Parse 402 body. If it's not a v2 PaymentRequirementsBody we
      // bail with the original response (caller's problem to handle).
      let body: PaymentRequirementsBody;
      try {
        body = (await res.clone().json()) as PaymentRequirementsBody;
      } catch {
        return res;
      }
      if (body?.x402Version !== 2 || !Array.isArray(body.accepts) || body.accepts.length === 0) {
        return res;
      }

      const chosen = select(body.accepts);
      if (!chosen) return res;

      const { signedTxCborHex, nonceRef } = await opts.pay(chosen);
      const header = encodePaymentEnvelope({
        network:         chosen.network,
        signedTxCborHex,
        nonceRef,
      });

      // Merge PAYMENT-SIGNATURE into headers without mutating caller's init.
      const mergedHeaders = new Headers(nextInit?.headers ?? init?.headers);
      mergedHeaders.set('PAYMENT-SIGNATURE', header);
      nextInit = { ...(nextInit ?? init ?? {}), headers: mergedHeaders };

      attemptsLeft--;
    }
  };
}
