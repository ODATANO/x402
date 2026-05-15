/**
 * Reference HTTP facilitator, the server side of `httpFacilitator()`.
 *
 * `httpFacilitator()` (in `./http.ts`) is the client wrapper that resource
 * servers wire into their middleware via the `facilitator` option. This
 * module is the matching server: a thin Express `Router` exposing the
 * three endpoints documented in `docs/facilitator-protocol.md`:
 *
 *   POST /verify-settle , runs the full pipeline through a `Facilitator`
 *   GET  /supported     , discovery
 *   GET  /healthz       , orchestrator health check
 *
 * The router is composable, consumers mount it under whatever path /
 * port / TLS / CORS / rate-limiter they prefer, no opinions baked in.
 * Auth is a single `auth(req)` hook, callers can implement bearer-token,
 * mTLS, signed-request, OAuth, etc. There is NO default auth, an
 * unconfigured router is open; document this loudly in deployment.
 *
 * The `onAccepted` callback CANNOT cross the HTTP boundary, the matching
 * client (`httpFacilitator()`) invokes it locally after the remote returns
 * `accepted`. To cover the facilitator-side audit need, this router
 * exposes `onRejected` and `onPending` hooks, fired exactly once per
 * non-accepted outcome, with the request available for context.
 */

import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import cds from '@sap/cds';
// Type-only import: keeps this module free of any runtime dependency on
// `@odatano/core` (which `localFacilitator` would pull in transitively).
// Consumers who want the default in-process facilitator pay that cost
// lazily when they omit the `facilitator` option, see resolveDefault().
import type {
  Facilitator,
  FacilitatorVerifyAndSettleArgs,
  FacilitatorResult,
} from './adapter';

const defaultLog = cds.log('x402');

export interface FacilitatorServerLogger {
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

export interface CreateFacilitatorRouterOptions {
  /**
   * Facilitator implementation. Default `localFacilitator()`, runs the
   * pipeline in-process via `@odatano/core`. Swap in a custom adapter
   * for testing or for chained facilitators.
   */
  facilitator?: Facilitator;
  /**
   * Optional auth gate. Returns truthy to allow, falsy to reject with
   * 401. Thrown errors are treated as 500. There is no default, an
   * unset hook means the router is open; configure in production.
   */
  auth?: (req: Request) => boolean | Promise<boolean>;
  /**
   * Body-size limit for `POST /verify-settle`. Default `'256kb'`,
   * envelopes are ≤ ~50 kB in practice. Format matches `express.json`.
   */
  jsonLimit?: string;
  /**
   * Best-effort audit hook fired exactly once per `rejected` outcome,
   * AFTER the response is sent. Errors are swallowed and logged.
   * `onAccepted` cannot cross HTTP, this is the rejected-side analog.
   */
  onRejected?: (result: Extract<FacilitatorResult, { kind: 'rejected' }>, req: Request) => void | Promise<void>;
  /**
   * Best-effort audit hook fired exactly once per `pending` outcome,
   * AFTER the response is sent. Same semantics as `onRejected`.
   */
  onPending?: (result: Extract<FacilitatorResult, { kind: 'pending' }>, req: Request) => void | Promise<void>;
  /** Custom logger. Default uses `cds.log('x402')`. */
  logger?: FacilitatorServerLogger;
}

async function runAudit<T extends FacilitatorResult>(
  result: T,
  req: Request,
  cb: ((r: T, req: Request) => void | Promise<void>) | undefined,
  log: FacilitatorServerLogger,
  label: string,
): Promise<void> {
  if (!cb) return;
  try {
    await cb(result, req);
  } catch (err) {
    log.warn(`facilitator-server: ${label} hook failed (non-fatal):`, err);
  }
}

/**
 * Build the facilitator HTTP router. Mount on whatever path you like:
 *
 *   const app = express();
 *   app.use('/v1', createFacilitatorRouter({ auth: bearer(token) }));
 *   app.listen(4040);
 *
 * The router parses its own JSON body, do not mount `express.json()`
 * upstream with a smaller limit, the inner parser will see an already-
 * parsed body and skip.
 */
function resolveDefaultFacilitator(): Facilitator {
  // Lazy require so the @odatano/core dependency is pulled in only when
  // a consumer actually uses the default. Tests and consumers that pass
  // a custom facilitator (e.g. a chained or mock one) never load core.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { localFacilitator } = require('./adapter') as typeof import('./adapter');
  return localFacilitator();
}

export function createFacilitatorRouter(opts: CreateFacilitatorRouterOptions = {}): Router {
  const facilitator = opts.facilitator ?? resolveDefaultFacilitator();
  const log         = opts.logger     ?? defaultLog as unknown as FacilitatorServerLogger;
  const jsonLimit   = opts.jsonLimit  ?? '256kb';

  const router = express.Router();

  // Body parser scoped to this router. We DO NOT install a global JSON
  // parser, callers may already have one with a different limit they
  // don't want overridden for the rest of their app.
  const json = express.json({ limit: jsonLimit });

  // Auth runs BEFORE body parsing so we don't waste CPU parsing
  // payloads for unauthenticated callers.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!opts.auth) return next();
    try {
      const ok = await opts.auth(req);
      if (!ok) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    } catch (err) {
      log.error('facilitator-server: auth hook threw', err);
      res.status(500).json({ error: 'auth check failed' });
    }
  });

  // ─── POST /verify-settle ─────────────────────────────────────────────
  router.post('/verify-settle', json, async (req: Request, res: Response) => {
    const body = req.body as Partial<FacilitatorVerifyAndSettleArgs> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'request body must be a JSON object' });
      return;
    }
    if (!body.paymentHeader) {
      // Don't 400 here, the facilitator returns a structured `rejected`
      // with `missing_payment_header` so clients get a uniform shape.
    }
    if (!body.requirementsBody || typeof body.requirementsBody !== 'object') {
      res.status(400).json({ error: 'requirementsBody is required' });
      return;
    }

    // Strip onAccepted defensively, the wire schema doesn't carry it
    // and we'd refuse to invoke a foreign callback anyway.
    const args: FacilitatorVerifyAndSettleArgs = {
      paymentHeader:    body.paymentHeader,
      requirementsBody: body.requirementsBody,
      ...(body.settlePollBudgetMs !== undefined ? { settlePollBudgetMs: body.settlePollBudgetMs } : {}),
      ...(body.allowNoTtl ? { allowNoTtl: true } : {}),
    };

    let result: FacilitatorResult;
    try {
      result = await facilitator.verifyAndSettle(args);
    } catch (err) {
      log.error('facilitator-server: verifyAndSettle threw', err);
      res.status(500).json({ error: (err as Error)?.message ?? 'internal error' });
      return;
    }

    res.json(result);

    // Audit hooks fire AFTER the response so a slow audit DB never
    // delays the buyer's settle round-trip.
    if (result.kind === 'rejected') {
      void runAudit(result, req, opts.onRejected, log, 'onRejected');
    } else if (result.kind === 'pending') {
      void runAudit(result, req, opts.onPending, log, 'onPending');
    }
  });

  // ─── GET /supported ──────────────────────────────────────────────────
  router.get('/supported', async (_req: Request, res: Response) => {
    if (!facilitator.supported) {
      // Spec allows minimal facilitators to omit /supported. We surface
      // 501 so the caller can distinguish "endpoint missing" from
      // "facilitator unavailable".
      res.status(501).json({ error: 'facilitator does not implement supported()' });
      return;
    }
    try {
      const s = await facilitator.supported();
      res.json(s);
    } catch (err) {
      log.error('facilitator-server: supported() threw', err);
      res.status(500).json({ error: (err as Error)?.message ?? 'internal error' });
    }
  });

  // ─── GET /healthz ────────────────────────────────────────────────────
  // Orchestrator-friendly liveness probe. NOT auth-gated, on purpose:
  // k8s / Cloud Run probes don't carry bearer tokens. If the auth hook
  // ran first and rejected the request, this route would be unreachable
  // to probes. We register healthz on a side-router that bypasses auth.
  // Implementation note: Express runs middlewares in registration order
  // for a router, so we install healthz on a SEPARATE router and mount
  // it before the auth middleware on the returned router. The cleanest
  // way: build healthz on a sub-router and mount FIRST.
  //
  // (Restructure: rebuild the router with healthz prepended.)
  const outer = express.Router();
  outer.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  outer.use(router);
  return outer;
}
