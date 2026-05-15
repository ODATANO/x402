/**
 * `httpFacilitator` — delegates verify+settle to a remote HTTP service.
 *
 * Wire format (see `docs/facilitator-protocol.md` for the full reference):
 *
 *   POST <url>/verify-settle
 *     body: { paymentHeader, requirementsBody, settlePollBudgetMs?, allowNoTtl? }
 *     200 → FacilitatorResult (accepted | rejected | pending)
 *     ≥400 → throws Error (the middleware translates to 500 to the buyer)
 *
 *   GET <url>/supported
 *     200 → { networks: string[], assetTransferMethods: string[] }
 *
 * Auth: optional `apiKey` sent as `Authorization: Bearer <key>`. For
 * custom schemes (mTLS, OAuth, HMAC), pass a `headers()` builder.
 *
 * `onAccepted` cannot cross HTTP — the wrapper strips it from the wire
 * payload and invokes it locally after the remote returns `accepted`.
 * This preserves the local-facilitator semantics exactly.
 */

import type {
  Facilitator,
  FacilitatorResult,
  FacilitatorSupportedResult,
  FacilitatorVerifyAndSettleArgs,
} from './adapter';

type FetchFn = typeof globalThis.fetch;

export interface HttpFacilitatorConfig {
  /** Base URL of the remote facilitator (no trailing slash required). */
  url: string;
  /** Optional API key — sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /**
   * Optional custom header builder, merged onto the defaults. Use for
   * mTLS, OAuth, signed-request auth, request IDs, etc.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Override the underlying fetch (testing, custom agents). */
  fetch?: FetchFn;
  /**
   * Per-request timeout in ms. Default 90_000 — needs to be longer than
   * the facilitator's settle-poll budget plus chain-confirmation latency.
   */
  timeoutMs?: number;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function httpFacilitator(config: HttpFacilitatorConfig): Facilitator {
  if (!config.url) {
    throw new TypeError('httpFacilitator: url is required');
  }
  const baseFetch: FetchFn = config.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new TypeError('httpFacilitator: no fetch implementation available (Node ≥18 or pass config.fetch)');
  }
  const timeoutMs = config.timeoutMs ?? 90_000;
  const baseUrl   = trimTrailingSlash(config.url);

  async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    if (config.headers) {
      const custom = await config.headers();
      Object.assign(h, custom);
    }
    return h;
  }

  async function withTimeout<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await op(ctrl.signal);
    } finally {
      clearTimeout(tid);
    }
  }

  return {
    async verifyAndSettle(args: FacilitatorVerifyAndSettleArgs): Promise<FacilitatorResult> {
      // Strip `onAccepted` — not transmittable. Invoke locally after the
      // remote settles, preserving local-facilitator semantics.
      const { onAccepted, ...wire } = args;

      const result = await withTimeout(async (signal) => {
        const res = await baseFetch(`${baseUrl}/verify-settle`, {
          method:  'POST',
          headers: await buildHeaders(),
          body:    JSON.stringify(wire),
          signal,
        });
        if (!res.ok) {
          throw new Error(
            `httpFacilitator: POST /verify-settle returned ${res.status} ${res.statusText}`,
          );
        }
        return (await res.json()) as FacilitatorResult;
      });

      if (result.kind === 'accepted' && onAccepted) {
        // Same best-effort semantics as the local facilitator —
        // swallow errors so accepted payments are never lost to a
        // failing audit callback.
        try { await onAccepted(result.payment); }
        catch { /* deliberately ignored — payment already on chain */ }
      }
      return result;
    },

    async supported(): Promise<FacilitatorSupportedResult> {
      return withTimeout(async (signal) => {
        const res = await baseFetch(`${baseUrl}/supported`, {
          method:  'GET',
          headers: await buildHeaders(),
          signal,
        });
        if (!res.ok) {
          throw new Error(
            `httpFacilitator: GET /supported returned ${res.status} ${res.statusText}`,
          );
        }
        return (await res.json()) as FacilitatorSupportedResult;
      });
    },
  };
}
