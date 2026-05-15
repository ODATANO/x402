/**
 * CAP integration for x402 payment gating.
 *
 * CAP services receive requests through `srv.before(...)` / `srv.on(...)`
 * handlers, not Express middleware. For OData-served entities, the 402
 * needs to come from `req.reject(402, body)`, the response is built by
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
import { buildPaymentRequirementsMulti } from '../core/requirements';
import { localFacilitator, type Facilitator } from '../facilitator/adapter';
import { Codes } from '../core/errors';
import { resolvePrice } from './pricing';
import { persistReceipt, resolveReceiptsEntity } from './receipts';
import {
  issueGrant,
  lookupGrant,
  resolveGrantsEntity,
  resolveGrantTtl,
} from './grants';
import type {
  AssetTransferMethod,
  Network,
  PaymentClaim,
  PriceSpec,
  PriceResolver,
  PricingContext,
} from '../core/types';

const log = cds.log('x402');

export interface X402CapOptions {
  payTo: string;
  network: Network | string;
  asset: string;
  /**
   * Single price (applies to all gated events). May be a scalar, a
   * `RouteOption`, or a `RouteOption[]` (multi-accept).
   */
  priceUnits?: PriceSpec;
  /**
   * Per-event prices. Either a static map (keys are CAP entity or
   * action names; events absent here pass through) or a `PriceResolver`
   * function for dynamic pricing. Resolver returning `null` skips the
   * gate; otherwise returns a scalar / `RouteOption` / `RouteOption[]`.
   */
  routePricing?: Record<string, PriceSpec> | PriceResolver;
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
   * Persist accepted payments to a CDS entity. Set to `true` to use the
   * default entity `odatano.x402.X402Receipts` (shipped in the plugin's
   * `db/x402-receipts.cds`), or pass `{ entity: 'my.namespace.MyTable' }`
   * to write to a consumer-defined table with the same shape.
   *
   * INSERT runs AFTER settle confirms, BEFORE the 200 response. INSERT
   * failures are logged and never block the response, the canonical
   * record is on chain. Pair with `onAccepted` if you need side-effects
   * beyond persistence.
   */
  receipts?: boolean | { entity?: string };
  /**
   * Time-limited grants: pay once, get `ttlSeconds` of free access to
   * the same route. On accepted payment, the gate issues an opaque
   * token and returns it via the `X-PAYMENT-GRANT` response header.
   * The buyer presents that token via the `X-PAYMENT-GRANT` request
   * header on subsequent calls; while it's valid the gate bypasses the
   * 402 + verify+settle pipeline.
   *
   * Default `ttlSeconds`: 3600. Default entity:
   * `odatano.x402.X402Grants` (shipped in `db/x402-grants.cds`).
   *
   * Grant errors (issue or lookup) are SWALLOWED. A failing DB never
   * denies a paying buyer their response; it just means no
   * subscription short-circuit until the DB recovers.
   */
  grants?: boolean | { ttlSeconds?: number; entity?: string };
  /**
   * Facilitator implementation handling verify+settle. Default
   * `localFacilitator()`, in-process via `@odatano/core`. Use
   * `httpFacilitator({ url, apiKey })` to delegate to a hosted service.
   */
  facilitator?: Facilitator;
}

type AnyCapService = {
  before(event: string | string[], handler: (req: cds.Request) => unknown): unknown;
  before(event: string | string[], entity: unknown, handler: (req: cds.Request) => unknown): unknown;
};

function getAllHeaders(req: cds.Request): Record<string, string | string[] | undefined> {
  const httpReq = (req as unknown as { http?: { req?: { headers?: Record<string, string | string[]> } }; _?: { req?: { headers?: Record<string, string | string[]> } } });
  return (httpReq.http?.req?.headers ?? httpReq._?.req?.headers ?? {}) as Record<string, string | string[] | undefined>;
}

function getHeader(req: cds.Request, name: string): string | undefined {
  const v = getAllHeaders(req)[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Build the `PricingContext` for `resolvePrice` from a CAP request.
 *
 * CAP fires two distinct event shapes:
 *   - CRUD on entity:  req.event === 'READ' | 'CREATE' | ...   ; req.target.name === '<Service>.<Entity>'
 *   - Action call:     req.event === '<actionName>'             ; req.target may be empty or bound entity
 *
 * We surface both `event` (the verb / action name) and `target` (the
 * fully-qualified entity name when present), giving the resolver enough
 * to discriminate CRUD-vs-action and per-entity pricing.
 */
function capContext(req: cds.Request): PricingContext {
  const event = String(req.event ?? '');
  const target = (req as unknown as { target?: { name?: string } }).target?.name;
  return {
    event,
    ...(target ? { target } : {}),
    headers: getAllHeaders(req),
  };
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
 * `routePricing`, registering per-entity would lose actions, and
 * per-event arrays don't support the `'*'` fallback we want.
 */
export function gateService<S extends cds.Service>(srv: S, opts: X402CapOptions): S {
  if (!opts.payTo)   throw new Error('gateService: payTo is required');
  if (!opts.network) throw new Error('gateService: network is required');
  if (!opts.asset)   throw new Error('gateService: asset is required');
  if (opts.priceUnits == null && !opts.routePricing) {
    throw new Error('gateService: priceUnits or routePricing is required');
  }
  const facilitator     = opts.facilitator ?? localFacilitator();
  const receiptsEntity  = resolveReceiptsEntity(opts.receipts);
  const grantsEntity    = resolveGrantsEntity(opts.grants);
  const grantTtlSeconds = resolveGrantTtl(opts.grants);

  (srv as unknown as AnyCapService).before('*', async function x402CapGate(req: cds.Request) {
    let options;
    try {
      options = await resolvePrice(opts, capContext(req));
    } catch (err) {
      log.error('x402 CAP gate pricing resolver threw', err);
      (req as unknown as { reject: (status: number, message: string) => void })
        .reject(500, 'x402 pricing error');
      return;
    }
    if (options == null) return; // unmapped → pass through

    // ─── Grant short-circuit ────────────────────────────────────────────
    // If the buyer presents a valid X-PAYMENT-GRANT for THIS route, skip
    // the whole 402 + verify+settle pipeline. We run the grant check
    // AFTER pricing resolution so passes-through paths don't hit the DB,
    // but BEFORE building the requirements body so we save the wasted
    // work when a grant is valid.
    if (grantsEntity) {
      const grantToken = getHeader(req, 'x-payment-grant');
      if (grantToken) {
        const route = getResourceUrl(req, opts);
        const result = await lookupGrant(grantsEntity, grantToken, route);
        if (result.kind === 'valid') return; // bypass gate entirely
        // expired / not-found → fall through to the payment path
      }
    }

    const requirementsBody = buildPaymentRequirementsMulti({
      options,
      asset:    opts.asset,
      payTo:    opts.payTo,
      network:  opts.network,
      resource: {
        url:         getResourceUrl(req, opts),
        description: opts.description ?? '',
        mimeType:    opts.mimeType ?? 'application/json',
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
    // Chain receipts INSERT before the user's onAccepted so consumers
    // can read back the persisted row inside their hook if they want to.
    // Receipts errors are swallowed inside `persistReceipt`, so the
    // user's onAccepted still runs.
    if (receiptsEntity || opts.onAccepted) {
      processArgs.onAccepted = async (claim) => {
        if (receiptsEntity) {
          await persistReceipt(receiptsEntity, claim, getResourceUrl(req, opts));
        }
        if (opts.onAccepted) await opts.onAccepted(claim, req);
      };
    }

    // ─── Run the pipeline. Only the orchestrator's internal errors are
    //     trapped here, `req.reject` MUST be called outside this catch
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
    //     and we let its synchronous throw bubble, CAP's dispatcher
    //     wraps it into the OData error response.
    if (result.kind === 'accepted') {
      (req as unknown as { payment?: PaymentClaim }).payment = result.payment;
      const httpRes = (req as unknown as { http?: { res?: { setHeader: (k: string, v: string) => void } } }).http?.res;
      httpRes?.setHeader('X-PAYMENT-RESPONSE', result.paymentResponseB64);

      // Issue a grant token, the buyer's next request can short-circuit
      // the 402 + settle path until expiry. Best-effort: a failed
      // issue just means no header gets set; the response is unaffected.
      if (grantsEntity) {
        const grant = await issueGrant(
          grantsEntity, result.payment, getResourceUrl(req, opts), grantTtlSeconds,
        );
        if (grant) {
          httpRes?.setHeader('X-PAYMENT-GRANT',         grant.token);
          httpRes?.setHeader('X-PAYMENT-GRANT-EXPIRES', grant.expiresAt);
        }
      }
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
