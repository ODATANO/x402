/**
 * `httpFacilitator`: calls an x402 v2 facilitator over HTTP (§7).
 *
 *   POST <url>/verify    { x402Version, paymentPayload, paymentRequirements } → VerifyResponse
 *   POST <url>/settle    same body                                            → SettlementResponse
 *   GET  <url>/supported                                                      → SupportedResponse
 *
 * Works with any spec-conformant facilitator, including
 * `createFacilitatorRouter()`. Auth: optional `apiKey` as bearer token, or
 * a `headers()` builder for other schemes.
 */

import type { Facilitator, SupportedResponse } from './adapter';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from '../core/types';

type FetchFn = typeof globalThis.fetch;

export interface HttpFacilitatorConfig {
  /** Base URL of the facilitator; a trailing slash is ignored. */
  url: string;
  /** Sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Extra headers, merged onto the defaults (mTLS, OAuth, signed requests, request ids). */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Override the underlying fetch (testing, custom agents). */
  fetch?: FetchFn;
  /** default 90_000; must exceed the facilitator's settle wait */
  timeoutMs?: number;
}

export function httpFacilitator(config: HttpFacilitatorConfig): Facilitator {
  if (!config.url) throw new TypeError('httpFacilitator: url is required');
  const baseFetch: FetchFn = config.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new TypeError('httpFacilitator: no fetch implementation available (Node >= 18 or pass config.fetch)');
  }
  const timeoutMs = config.timeoutMs ?? 90_000;
  const baseUrl   = config.url.replace(/\/+$/, '');

  async function buildHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    if (config.headers) Object.assign(h, await config.headers());
    return h;
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await baseFetch(`${baseUrl}${path}`, {
        method,
        headers: await buildHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`httpFacilitator: ${method} ${path} returned ${res.status} ${res.statusText}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(tid);
    }
  }

  const request = (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) =>
    ({ x402Version: 2, paymentPayload, paymentRequirements });

  return {
    verify: (payload, requirements) => call<VerifyResponse>('POST', '/verify', request(payload, requirements)),
    settle: (payload, requirements) => call<SettlementResponse>('POST', '/settle', request(payload, requirements)),
    supported: () => call<SupportedResponse>('GET', '/supported'),
  };
}
