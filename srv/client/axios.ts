/**
 * `x402Axios`, attach a response interceptor to an existing axios
 * instance so 402 responses trigger a payment and retry (x402 v2, HTTP).
 *
 * No hard axios dependency: the instance is typed structurally. Verified
 * against axios 1.x.
 *
 *   const client = x402Axios(axios.create({ baseURL: '...' }), {
 *     pay: createBridgePayHandler({ buyerBech32, signTx }),
 *   });
 *   await client.get('/api/premium/foo');   // 200 after paying
 */

import { X402PaymentError, paymentErrorFrom } from './errors';
import { encodePaymentPayload, isSettlementPending, readPaymentRequired, readSettlement } from './protocol';
import { selectFirstSupported } from './select';
import type { X402ClientOptions } from './types';

// Marker keys on the request config: payment retries, and same-header re-sends while pending.
const RETRY_KEY = '__x402_x402Retries';
const PENDING_KEY = '__x402_x402PendingRetries';

interface AxiosErrorLike {
  response?: { status?: number; headers?: unknown };
  config?: AxiosRequestConfigLike;
}
interface AxiosRequestConfigLike {
  headers?: Record<string, unknown>;
  [k: string]: unknown;
}
interface AxiosInstanceLike {
  interceptors: {
    response: {
      use: (
        onFulfilled: (res: unknown) => unknown,
        onRejected: (err: unknown) => unknown,
      ) => number;
    };
  };
  request: (cfg: AxiosRequestConfigLike) => Promise<unknown>;
}

function isAxiosError(e: unknown): e is AxiosErrorLike {
  return !!e && typeof e === 'object' && 'response' in e;
}

/** Header value from axios response headers (plain object or AxiosHeaders, lower-cased names). */
function headerOf(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  const v = typeof h.get === 'function' ? h.get(name) : h[name.toLowerCase()] ?? h[name];
  return typeof v === 'string' ? v : undefined;
}

export function x402Axios<T extends AxiosInstanceLike>(instance: T, opts: X402ClientOptions): T {
  if (typeof opts?.pay !== 'function') {
    throw new TypeError('x402Axios: opts.pay must be a function');
  }
  const maxRetries     = opts.maxRetries ?? 1;
  const pendingRetries = opts.pendingRetries ?? 5;
  const pendingDelayMs = opts.pendingRetryDelayMs ?? 2_000;
  const select         = opts.selectAccepts ?? selectFirstSupported;

  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (!isAxiosError(error) || error.response?.status !== 402 || !error.config) {
        throw error;
      }
      const cfg = error.config;
      const status = error.response.status;
      const paymentRequired = readPaymentRequired(headerOf(error.response.headers, 'payment-required'));
      const settlement = readSettlement(headerOf(error.response.headers, 'payment-response'));
      const withSettlement = settlement ? { settlement } : {};

      if (isSettlementPending(settlement)) {
        const pends = Number(cfg[PENDING_KEY] ?? 0);
        if (pends >= pendingRetries) {
          if (opts.errorOnFailure) {
            throw paymentErrorFrom(paymentRequired, { kind: 'settlement_pending', httpStatus: status, ...withSettlement, cause: error });
          }
          throw error;
        }
        await new Promise(r => setTimeout(r, pendingDelayMs));
        return instance.request({ ...cfg, [PENDING_KEY]: pends + 1 });
      }

      const retries = Number(cfg[RETRY_KEY] ?? 0);
      if (retries >= maxRetries) {
        if (opts.errorOnFailure) {
          throw paymentErrorFrom(paymentRequired, { kind: 'retries_exhausted', httpStatus: status, ...withSettlement, cause: error });
        }
        throw error;
      }
      if (!paymentRequired || paymentRequired.accepts.length === 0) {
        if (opts.errorOnFailure) {
          throw new X402PaymentError({
            message:    'x402Axios: 402 without a valid PAYMENT-REQUIRED header',
            kind:       'invalid_payment_required',
            httpStatus: status,
            cause:      error,
          });
        }
        throw error;
      }

      const chosen = select(paymentRequired.accepts);
      if (!chosen) {
        if (opts.errorOnFailure) {
          throw paymentErrorFrom(paymentRequired, { kind: 'server_rejected', httpStatus: status, cause: error });
        }
        throw error;
      }

      let paid;
      try {
        paid = await opts.pay(chosen, paymentRequired);
      } catch (err) {
        throw new X402PaymentError({
          message: `x402Axios: pay handler failed: ${(err as { message?: string })?.message ?? String(err)}`,
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

      return instance.request({
        ...cfg,
        headers: { ...(cfg.headers ?? {}), 'PAYMENT-SIGNATURE': header },
        [RETRY_KEY]: retries + 1,
      });
    },
  );

  return instance;
}
