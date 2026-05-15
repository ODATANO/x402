/**
 * CAP integration for x402 payment gating.
 *
 * CAP services receive requests through `srv.before(...)` / `srv.on(...)`
 * handlers, not Express middleware. For OData-served entities, the 402
 * needs to come from `req.reject(402, body)` — the response is built by
 * CAP, not by `res.status(...)`.
 *
 * Usage:
 *
 *   import { gateService } from '@odatano/x402';
 *
 *   class MyService extends cds.ApplicationService {
 *     async init() {
 *       gateService(this, {
 *         payTo: '...', network: 'cardano:preprod', asset: '<policy>.<name>',
 *         routePricing: { Prices: '10000', getBestPrice: '10000' },
 *       });
 *       return super.init();
 *     }
 *   }
 *
 * The gate inspects each `req.event` (entity name OR action name) and
 * matches it against `routePricing`. For unmapped events / entities,
 * the request passes through unmodified.
 */

import cds from '@sap/cds';
import { buildPaymentRequirements } from '../core/requirements';
import { localFacilitator, type Facilitator } from '../facilitator/adapter';
import { Codes } from '../core/errors';
import type { AssetTransferMethod, Network, PaymentClaim } from '../core/types';

const log = cds.log('x402');

export interface X402CapOptions {
  payTo: string;
  network: Network | string;
  asset: string;
  /** Single price (applies to all gated events). */
  priceUnits?: string | number | bigint;
  /**
   * Per-event prices. Keys are CAP event names (entity name for CRUD,
   * action name for actions). Events absent here pass through.
   */
  routePricing?: Record<string, string | number | bigint>;
  description?: string;
  mimeType?: string;
  assetTransferMethod?: AssetTransferMethod;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  settlePollBudgetMs?: number;
  allowNoTtl?: boolean;
  onAccepted?: (claim: PaymentClaim, req: cds.Request) => void | Promise<void>;
  /**
   * Optional resource URL builder. Defaults to the request's HTTP URL
   * when available, falling back to `cap://<event>`. Pass a custom
   * builder to embed pair / entity id in the resource string.
   */
  resourceUrl?: (req: cds.Request) => string;
  /**
   * Facilitator implementation handling verify+settle. Default
   * `localFacilitator()` — in-process via `@odatano/core`. Use
   * `httpFacilitator({ url, apiKey })` to delegate to a hosted service.
   */
  facilitator?: Facilitator;
}

type AnyCapService = {
  before(event: string | string[], handler: (req: cds.Request) => unknown): unknown;
  before(event: string | string[], entity: unknown, handler: (req: cds.Request) => unknown): unknown;
};

/**
 * Resolve the routePricing key for a CAP request.
 *
 * CAP fires two distinct shapes:
 *   - CRUD on an entity:  req.event === 'READ' | 'CREATE' | 'UPDATE' | 'DELETE'
 *                         req.target.name === '<Service>.<Entity>'
 *   - Action call:        req.event === '<actionName>'
 *                         req.target may be empty or the bound-entity target
 *
 * routePricing keys are meant to be human-readable identifiers (entity
 * names or action names), so we try the entity name first (more specific)
 * and fall back to the event verb. Either match wins; both miss falls
 * through to opts.priceUnits or null.
 */
function pickPriceUnits(req: cds.Request, opts: X402CapOptions): string | null {
  if (opts.routePricing) {
    const event = String(req.event ?? '');
    const targetName = (req as unknown as { target?: { name?: string } }).target?.name ?? '';
    const entitySegment = targetName.split('.').pop() ?? '';
    const price = opts.routePricing[entitySegment] ?? opts.routePricing[event];
    if (price != null) return String(price);
    if (opts.priceUnits != null) return String(opts.priceUnits);
    return null;
  }
  return opts.priceUnits != null ? String(opts.priceUnits) : null;
}

function getHeader(req: cds.Request, name: string): string | undefined {
  // CAP's req.http?.req exposes the underlying express request. Fall
  // back to req._.req for older shapes.
  const httpReq = (req as unknown as { http?: { req?: { headers?: Record<string, string | string[]> } }; _?: { req?: { headers?: Record<string, string | string[]> } } });
  const hdrs = httpReq.http?.req?.headers ?? httpReq._?.req?.headers;
  const v = hdrs?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function getResourceUrl(req: cds.Request, opts: X402CapOptions): string {
  if (opts.resourceUrl) return opts.resourceUrl(req);
  const httpReq = (req as unknown as { http?: { req?: { originalUrl?: string; url?: string } } });
  return httpReq.http?.req?.originalUrl ?? httpReq.http?.req?.url ?? `cap://${req.event}`;
}

/**
 * Attach the x402 gate to a CAP ApplicationService. Returns the service
 * (chainable) so callers can fluently wire multiple middlewares.
 *
 * The gate registers as `srv.before('*', ...)` which fires for every
 * event on the service. We filter inside the handler based on
 * `routePricing` — registering per-entity would lose actions, and
 * per-event arrays don't support the `'*'` fallback we want.
 */
export function gateService<S extends cds.Service>(srv: S, opts: X402CapOptions): S {
  if (!opts.payTo)   throw new Error('gateService: payTo is required');
  if (!opts.network) throw new Error('gateService: network is required');
  if (!opts.asset)   throw new Error('gateService: asset is required');
  if (opts.priceUnits == null && !opts.routePricing) {
    throw new Error('gateService: priceUnits or routePricing is required');
  }
  const facilitator = opts.facilitator ?? localFacilitator();

  (srv as unknown as AnyCapService).before('*', async function x402CapGate(req: cds.Request) {
    const priceUnits = pickPriceUnits(req, opts);
    if (priceUnits == null) return; // unmapped → pass through

    const requirementsBody = buildPaymentRequirements({
      amount: priceUnits,
      asset: opts.asset,
      payTo: opts.payTo,
      network: opts.network,
      resource: {
        url: getResourceUrl(req, opts),
        description: opts.description ?? '',
        mimeType: opts.mimeType ?? 'application/json',
      },
      ...(opts.assetTransferMethod ? { assetTransferMethod: opts.assetTransferMethod } : {}),
      ...(opts.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}),
      ...(opts.extra ? { extra: opts.extra } : {}),
      withMissingHeaderError: true,
    });

    const headerVal = getHeader(req, 'payment-signature');
    const processArgs: Parameters<Facilitator['verifyAndSettle']>[0] = {
      paymentHeader: headerVal,
      requirementsBody,
    };
    if (opts.settlePollBudgetMs !== undefined) {
      processArgs.settlePollBudgetMs = opts.settlePollBudgetMs;
    }
    if (opts.allowNoTtl) processArgs.allowNoTtl = true;
    if (opts.onAccepted) {
      processArgs.onAccepted = (claim) => opts.onAccepted!(claim, req);
    }

    // ─── Run the pipeline. Only the orchestrator's internal errors are
    //     trapped here — `req.reject` MUST be called outside this catch
    //     because it throws synchronously, and re-catching that throw
    //     would translate the 402 into a 500. ─────────────────────────
    let result: Awaited<ReturnType<Facilitator['verifyAndSettle']>>;
    try {
      result = await facilitator.verifyAndSettle(processArgs);
    } catch (err) {
      log.error('x402 CAP gate internal error', err);
      // `reject` throws; we DO NOT wrap this in another try/catch.
      (req as unknown as { reject: (status: number, message: string) => void })
        .reject(500, 'x402 internal error');
      return;
    }

    // ─── Apply the result. From here on, `req.reject` is called once
    //     and we let its synchronous throw bubble — CAP's dispatcher
    //     wraps it into the OData error response.
    if (result.kind === 'accepted') {
      (req as unknown as { payment?: PaymentClaim }).payment = result.payment;
      const httpRes = (req as unknown as { http?: { res?: { setHeader: (k: string, v: string) => void } } }).http?.res;
      httpRes?.setHeader('X-PAYMENT-RESPONSE', result.paymentResponseB64);
      return;
    }

    // rejected | pending → 402 with the requirements body
    const body: Record<string, unknown> = { ...result.requirementsBody };
    const baseError = (result.requirementsBody.error ?? 'payment required').toString();
    if (result.code && result.code !== Codes.MISSING_HEADER) {
      body.error = `${baseError} (${result.code}): ${result.reason ?? ''}`.trim();
    }
    if (result.kind === 'pending') {
      body.pending = true;
      if (result.txHash) body.transaction = result.txHash;
    }
    (req as unknown as { reject: (status: number, message: string) => void })
      .reject(402, JSON.stringify(body));
  });

  return srv;
}
