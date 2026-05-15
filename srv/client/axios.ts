/**
 * `x402Axios`, attach a response interceptor to an existing axios
 * instance so 402 responses trigger a payment and retry.
 *
 * **No hard axios dependency.** We use structural typing for the
 * instance: anything with the standard axios shape (interceptors,
 * request, defaults.headers) works. Verified against axios 1.x.
 *
 * Usage:
 *   import axios from 'axios';
 *   import { x402Axios, createBridgePayHandler } from '@odatano/x402';
 *
 *   const client = x402Axios(axios.create({ baseURL: '...' }), {
 *     pay: createBridgePayHandler({ buyerBech32, signTx }),
 *   });
 *   await client.get('/api/premium/foo');   // returns 200 after pay
 */

import { encodePaymentEnvelope } from './envelope';
import type { X402ClientOptions } from './types';
import type { PaymentRequirementsBody, PaymentRequirementEntry } from '../core/types';

// Marker key on the config to break infinite-retry loops.
const RETRY_KEY = '__x402_x402Retries';

// ─── Structural axios shape ──────────────────────────────────────────
// We only spell out what we actually touch.

interface AxiosErrorLike {
  response?: { status?: number; data?: unknown };
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

/**
 * Attach the x402 response interceptor in-place and return the same
 * instance for chaining. The interceptor only fires on 402 responses;
 * everything else passes through unchanged.
 */
export function x402Axios<T extends AxiosInstanceLike>(
  instance: T,
  opts: X402ClientOptions,
): T {
  if (typeof opts?.pay !== 'function') {
    throw new TypeError('x402Axios: opts.pay must be a function');
  }
  const maxRetries  = opts.maxRetries ?? 1;
  const selectFirst = (a: PaymentRequirementEntry[]) => a[0];
  const select      = opts.selectAccepts ?? selectFirst;

  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (!isAxiosError(error) || error.response?.status !== 402 || !error.config) {
        throw error;
      }
      const cfg = error.config;
      const retries = Number(cfg[RETRY_KEY] ?? 0);
      if (retries >= maxRetries) throw error;

      const body = error.response.data as PaymentRequirementsBody | undefined;
      if (body?.x402Version !== 2 || !Array.isArray(body.accepts) || body.accepts.length === 0) {
        throw error;
      }

      const chosen = select(body.accepts);
      if (!chosen) throw error;

      const { signedTxCborHex, nonceRef } = await opts.pay(chosen);
      const header = encodePaymentEnvelope({
        network:         chosen.network,
        signedTxCborHex,
        nonceRef,
      });

      const nextCfg: AxiosRequestConfigLike = {
        ...cfg,
        headers: { ...(cfg.headers ?? {}), 'PAYMENT-SIGNATURE': header },
        [RETRY_KEY]: retries + 1,
      };
      return instance.request(nextCfg);
    },
  );

  return instance;
}
