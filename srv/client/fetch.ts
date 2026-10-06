/**
 * `x402Fetch`, drop-in fetch wrapper that pays 402 responses (x402 v2, HTTP).
 *
 * On a 402 the wrapper:
 *   1. reads `PaymentRequired` from the `PAYMENT-REQUIRED` header,
 *   2. picks an `accepts[]` entry (`selectAccepts`),
 *   3. calls the `pay` handler for the signed tx and nonce,
 *   4. retries with `PAYMENT-SIGNATURE` (`accepted`, `resource`, `extensions` echoed).
 *
 * A 402 whose `PAYMENT-RESPONSE` says `settlement_pending` is answered by
 * re-sending the same header, never by paying again. After `maxRetries`
 * payments the last response is returned (or thrown under `errorOnFailure`).
 */

import { X402PaymentError, paymentErrorFrom } from './errors';
import { encodePaymentPayload, isSettlementPending, readPaymentRequired, readSettlement } from './protocol';
import { selectFirstSupported } from './select';
import type { X402ClientOptions } from './types';
import type { PaymentRequired } from '../core/types';

type FetchFn = typeof globalThis.fetch;

export interface X402FetchOptions extends X402ClientOptions {
  /** Override the underlying fetch. Defaults to `globalThis.fetch`. */
  fetch?: FetchFn;
}

export function x402Fetch(opts: X402FetchOptions): FetchFn {
  if (typeof opts?.pay !== 'function') {
    throw new TypeError('x402Fetch: opts.pay must be a function');
  }
  const baseFetch: FetchFn = opts.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new TypeError('x402Fetch: no fetch implementation available (Node >= 18 or pass opts.fetch)');
  }

  const maxRetries     = opts.maxRetries ?? 1;
  const pendingRetries = opts.pendingRetries ?? 5;
  const pendingDelayMs = opts.pendingRetryDelayMs ?? 2_000;
  const select         = opts.selectAccepts ?? selectFirstSupported;

  return async function paidFetch(input, init) {
    let attemptsLeft = maxRetries;
    let pendingLeft  = pendingRetries;
    let nextInit = init;
    let lastRequired: PaymentRequired | undefined;

    for (;;) {
      const res = await baseFetch(input, nextInit);
      if (res.status !== 402) return res;

      const paymentRequired = readPaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
      const settlement = readSettlement(res.headers.get('PAYMENT-RESPONSE'));
      if (paymentRequired) lastRequired = paymentRequired;

      if (isSettlementPending(settlement)) {
        if (pendingLeft > 0) {
          pendingLeft--;
          await new Promise(r => setTimeout(r, pendingDelayMs));
          continue;
        }
        if (opts.errorOnFailure) {
          throw paymentErrorFrom(lastRequired, { kind: 'settlement_pending', httpStatus: res.status, ...(settlement ? { settlement } : {}) });
        }
        return res;
      }

      if (attemptsLeft <= 0) {
        if (opts.errorOnFailure) {
          throw paymentErrorFrom(lastRequired, { kind: 'retries_exhausted', httpStatus: res.status, ...(settlement ? { settlement } : {}) });
        }
        return res;
      }

      if (!paymentRequired || paymentRequired.accepts.length === 0) {
        if (opts.errorOnFailure) {
          throw new X402PaymentError({
            message:    'x402Fetch: 402 without a valid PAYMENT-REQUIRED header',
            kind:       'invalid_payment_required',
            httpStatus: res.status,
          });
        }
        return res;
      }

      const chosen = select(paymentRequired.accepts);
      if (!chosen) {
        if (opts.errorOnFailure) {
          throw paymentErrorFrom(paymentRequired, { kind: 'server_rejected', httpStatus: res.status });
        }
        return res;
      }

      // Pay-handler errors are always wrapped, regardless of errorOnFailure.
      let paid;
      try {
        paid = await opts.pay(chosen, paymentRequired);
      } catch (err) {
        throw new X402PaymentError({
          message: `x402Fetch: pay handler failed: ${(err as { message?: string })?.message ?? String(err)}`,
          kind:    'pay_handler_failed',
          accepts: paymentRequired.accepts,
          cause:   err,
        });
      }
      const header = encodePaymentPayload({
        paymentRequired,
        accepted:        chosen,
        signedTxCborHex: paid.signedTxCborHex,
        nonceRef:        paid.nonceRef,
      });

      // Copy headers so the caller's init is never mutated.
      const headers = new Headers(nextInit?.headers ?? init?.headers);
      headers.set('PAYMENT-SIGNATURE', header);
      nextInit = { ...(nextInit ?? init ?? {}), headers };
      attemptsLeft--;
    }
  };
}
