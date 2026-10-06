/**
 * CAP integration for x402 payment gating (Cardano `exact`).
 *
 *   class MyService extends cds.ApplicationService {
 *     async init() {
 *       gateService(this, {
 *         payTo: '...', network: 'cardano:preprod', asset: 'lovelace',
 *         routePricing: { Prices: '1000000', getBestPrice: '1000000' },
 *       });
 *       return super.init();
 *     }
 *   }
 *
 * The gate matches each `req.event` (entity or action) against
 * `routePricing`; unmapped events pass through. Flow (`authorization`):
 * `before` verifies the payment, the handler runs and its transaction
 * commits, then the payment is settled before the response is written. A
 * failed handler is never settled. A failed settle answers 402; what the
 * handler wrote stays committed, and a pending retry runs the handler
 * again, so gated handlers should be safe to repeat.
 *
 * Settling after the commit keeps the request's database connection free
 * during the wait for confirmations.
 */

import cds from '@sap/cds';
import { defaultFacilitator, localFacilitator, type Facilitator } from '../facilitator/adapter';
import { cdsSettlementStore, DEFAULT_SETTLEMENTS_ENTITY } from '../facilitator/cds-store';
import { entityOption } from '../helpers/db';
import { resolvePrice } from './pricing';
import { persistReceipt, DEFAULT_RECEIPTS_ENTITY } from './receipts';
import { issueGrant, lookupGrant, resolveGrantTtl, DEFAULT_GRANTS_ENTITY } from './grants';
import { startPayment, finishPayment, type HttpAnswer, type PaymentGateOptions, type PaymentSession } from './flow';
import type {
  PaymentClaim,
  PriceSpec,
  PriceResolver,
  PricingContext,
} from '../core/types';

const log = cds.log('x402');

export interface X402CapOptions extends PaymentGateOptions {
  /** Single price for all gated events: scalar, `RouteOption` or `RouteOption[]`. */
  priceUnits?: PriceSpec;
  /**
   * Per-event prices keyed by entity or action name (unmapped events pass
   * through), or a `PriceResolver`; a resolver returning `null` skips the gate.
   */
  routePricing?: Record<string, PriceSpec> | PriceResolver;
  /** Audit callback after settlement; errors are logged. */
  onAccepted?: (claim: PaymentClaim, req: cds.Request) => void | Promise<void>;
  /** default: the request's HTTP URL, else `cap://<event>` */
  resourceUrl?: (req: cds.Request) => string;
  /**
   * Persist settled payments: `true` uses `odatano.x402.X402Receipts`
   * (`db/x402-receipts.cds`), `{ entity }` a table of the same shape.
   * Runs after settlement in its own transaction; insert errors are logged, never block the response.
   */
  receipts?: boolean | { entity?: string };
  /**
   * Time-limited grants: after a settled payment the gate issues a token
   * (`X-PAYMENT-GRANT`, `X-PAYMENT-GRANT-EXPIRES`). While it is valid, the
   * same route needs no payment. Server policy, not part of x402.
   * Default `ttlSeconds` 3600, entity `odatano.x402.X402Grants`.
   */
  grants?: boolean | { ttlSeconds?: number; entity?: string };
  /**
   * Keep settlement claims in a CDS entity instead of process memory, so
   * several instances of the service share them: `true` uses
   * `odatano.x402.X402Settlements`, `{ entity }` a table of the same shape.
   * Only applies to the default facilitator.
   */
  settlements?: boolean | { entity?: string };
  /** default: the process-wide `defaultFacilitator()`, or one per `settlements` entity */
  facilitator?: Facilitator;
}

type CapHandler = (req: cds.Request) => unknown;
type AnyCapService = {
  before(event: string, handler: CapHandler): unknown;
};

type HttpRes = {
  setHeader: (k: string, v: string) => void;
  status: (n: number) => HttpRes;
  json: (b: unknown) => HttpRes;
  headersSent?: boolean;
};

type GatedRequest = cds.Request & {
  payment?: PaymentClaim;
  on(event: 'succeeded', listener: () => unknown): unknown;
};

/** One facilitator per settlements entity, shared by every gate of the process. */
const cdsFacilitators = new Map<string, Facilitator>();

function cdsFacilitator(entity: string): Facilitator {
  let f = cdsFacilitators.get(entity);
  if (!f) cdsFacilitators.set(entity, f = localFacilitator({ store: cdsSettlementStore(entity) }));
  return f;
}

function getAllHeaders(req: cds.Request): Record<string, string | string[] | undefined> {
  const r = req as unknown as { http?: { req?: { headers?: Record<string, string | string[]> } } };
  return (r.http?.req?.headers ?? {}) as Record<string, string | string[] | undefined>;
}

function getHeader(req: cds.Request, name: string): string | undefined {
  const v = getAllHeaders(req)[name];
  return Array.isArray(v) ? v[0] : v;
}

function getHttpRes(req: cds.Request): HttpRes | undefined {
  return (req as unknown as { http?: { res?: HttpRes } }).http?.res;
}

/**
 * Pricing context of a CAP request: `event` is the verb or action name,
 * `target` the qualified entity name when there is one.
 */
function capContext(req: cds.Request): PricingContext {
  const event = String(req.event ?? '');
  const target = (req as unknown as { target?: { name?: string } }).target?.name;
  return { event, ...(target ? { target } : {}), headers: getAllHeaders(req) };
}

function getResourceUrl(req: cds.Request, opts: X402CapOptions): string {
  if (opts.resourceUrl) return opts.resourceUrl(req);
  const r = req as unknown as { http?: { req?: { originalUrl?: string; url?: string } } };
  return r.http?.req?.originalUrl ?? r.http?.req?.url ?? `cap://${req.event}`;
}

function reject(req: cds.Request, status: number, message: string): void {
  (req as unknown as { reject: (status: number, message: string) => void }).reject(status, message);
}

/**
 * Answer with the x402 status, headers and JSON body. When an HTTP
 * response is reachable we write it ourselves, so clients see the plain
 * `PaymentRequired` instead of CAP's OData error wrapper. `req.reject` is
 * always called: its throw ends CAP's pipeline.
 */
function sendAnswer(req: cds.Request, answer: HttpAnswer): void {
  const httpRes = getHttpRes(req);
  if (httpRes && !httpRes.headersSent) {
    for (const [k, v] of Object.entries(answer.headers)) httpRes.setHeader(k, v);
    httpRes.status(answer.status).json(answer.body);
  }
  reject(req, answer.status, JSON.stringify(answer.body));
}

/** Attach the x402 gate to a CAP ApplicationService; returns the service. */
export function gateService<S extends cds.Service>(srv: S, opts: X402CapOptions): S {
  if (!opts.payTo)   throw new Error('gateService: payTo is required');
  if (!opts.network) throw new Error('gateService: network is required');
  if (!opts.asset)   throw new Error('gateService: asset is required');
  if (opts.priceUnits == null && !opts.routePricing) {
    throw new Error('gateService: priceUnits or routePricing is required');
  }
  const settlementsEntity = entityOption(opts.settlements, DEFAULT_SETTLEMENTS_ENTITY);
  const facilitator     = opts.facilitator
    ?? (settlementsEntity ? cdsFacilitator(settlementsEntity) : defaultFacilitator());
  const receiptsEntity  = entityOption(opts.receipts, DEFAULT_RECEIPTS_ENTITY);
  const grantsEntity    = entityOption(opts.grants, DEFAULT_GRANTS_ENTITY);
  const grantTtlSeconds = resolveGrantTtl(opts.grants);
  const service = srv as unknown as AnyCapService;

  service.before('*', async function x402CapVerify(req: cds.Request) {
    let options;
    try {
      options = await resolvePrice(opts, capContext(req));
    } catch (err) {
      log.error('x402 CAP gate pricing resolver threw', err);
      reject(req, 500, 'x402 pricing error');
      return;
    }
    if (options == null) return; // unmapped → pass through

    // A valid grant for this route skips payment.
    if (grantsEntity) {
      const grantToken = getHeader(req, 'x-payment-grant');
      if (grantToken) {
        const result = await lookupGrant(grantsEntity, grantToken, getResourceUrl(req, opts));
        if (result.kind === 'valid') return;
      }
    }

    // `reject` throws synchronously; it must stay outside the try, or its
    // throw would turn the 402 into a 500.
    let started: Awaited<ReturnType<typeof startPayment>>;
    try {
      started = await startPayment(
        opts, facilitator, options, getResourceUrl(req, opts), getHeader(req, 'payment-signature'),
      );
    } catch (err) {
      log.error('x402 CAP gate internal error', err);
      reject(req, 500, 'x402 internal error');
      return;
    }
    if (started.kind === 'answer') {
      sendAnswer(req, started.answer);
      return;
    }
    const gated = req as GatedRequest;
    gated.payment = started.session.claim;
    // Runs after the handler's transaction committed, before the response is written.
    gated.on('succeeded', () => settle(req, started.session));
  });

  async function settle(req: cds.Request, session: PaymentSession): Promise<void> {
    let finished: Awaited<ReturnType<typeof finishPayment>>;
    try {
      finished = await finishPayment(facilitator, session);
    } catch (err) {
      log.error('x402 CAP settle failed', err);
      reject(req, 500, 'x402 settlement error');
      return;
    }
    if (finished.kind === 'answer') {
      sendAnswer(req, finished.answer);
      return;
    }

    (req as GatedRequest).payment = finished.claim;
    const httpRes = getHttpRes(req);
    for (const [k, v] of Object.entries(finished.headers)) httpRes?.setHeader(k, v);
    const route = getResourceUrl(req, opts);
    if (receiptsEntity) await persistReceipt(receiptsEntity, finished.claim, route);
    if (opts.onAccepted) {
      try { await opts.onAccepted(finished.claim, req); }
      catch (err) { log.warn('onAccepted callback failed (non-fatal):', (err as Error)?.message ?? err); }
    }
    if (grantsEntity) {
      const grant = await issueGrant(grantsEntity, finished.claim, route, grantTtlSeconds);
      if (grant) {
        httpRes?.setHeader('X-PAYMENT-GRANT',         grant.token);
        httpRes?.setHeader('X-PAYMENT-GRANT-EXPIRES', grant.expiresAt);
      }
    }
  }

  return srv;
}
