/**
 * Serve a facilitator over HTTP as x402 v2 specifies (§7):
 *
 *   POST /verify     { x402Version, paymentPayload, paymentRequirements } → VerifyResponse
 *   POST /settle     same body                                            → SettlementResponse
 *   GET  /supported                                                       → SupportedResponse
 *   GET  /healthz    liveness, not auth-gated
 *
 * Mount it under any path. Auth is one `auth(req)` hook; there is no
 * default, so an unconfigured router is open.
 */

import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import cds from '@sap/cds';
// Type-only import: the default facilitator (and with it `@odatano/core`)
// loads lazily, only when no `facilitator` option is passed.
import type { Facilitator } from './adapter';
import type { PaymentPayload, PaymentRequirements, SettlementResponse } from '../core/types';

const defaultLog = cds.log('x402');

export interface FacilitatorServerLogger {
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

export interface CreateFacilitatorRouterOptions {
  /** default `localFacilitator()` */
  facilitator?: Facilitator;
  /** Truthy allows, falsy answers 401, a throw answers 500. Unset: open. */
  auth?: (req: Request) => boolean | Promise<boolean>;
  /** default '256kb'; body limit of `/verify` and `/settle` */
  jsonLimit?: string;
  /** Audit hook after every `/settle` answer, fired after the response; errors are logged. */
  onSettle?: (response: SettlementResponse, req: Request) => void | Promise<void>;
  /** default `cds.log('x402')` */
  logger?: FacilitatorServerLogger;
}

function resolveDefaultFacilitator(): Facilitator {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { localFacilitator } = require('./adapter') as typeof import('./adapter');
  return localFacilitator();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createFacilitatorRouter(opts: CreateFacilitatorRouterOptions = {}): Router {
  const facilitator = opts.facilitator ?? resolveDefaultFacilitator();
  const log         = opts.logger ?? (defaultLog as unknown as FacilitatorServerLogger);
  const json        = express.json({ limit: opts.jsonLimit ?? '256kb' });

  const router = express.Router();

  // Auth before body parsing, so unauthenticated payloads are never parsed.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!opts.auth) return next();
    try {
      if (!(await opts.auth(req))) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    } catch (err) {
      log.error('facilitator-server: auth hook threw', err);
      res.status(500).json({ error: 'auth check failed' });
    }
  });

  function readRequest(req: Request, res: Response): { payload: PaymentPayload; requirements: PaymentRequirements } | null {
    const body = req.body as unknown;
    if (!isObject(body) || body.x402Version !== 2 || !isObject(body.paymentPayload) || !isObject(body.paymentRequirements)) {
      res.status(400).json({ error: 'body must be { x402Version: 2, paymentPayload, paymentRequirements }' });
      return null;
    }
    return {
      payload:      body.paymentPayload as unknown as PaymentPayload,
      requirements: body.paymentRequirements as unknown as PaymentRequirements,
    };
  }

  router.post('/verify', json, async (req: Request, res: Response) => {
    const r = readRequest(req, res);
    if (!r) return;
    try {
      res.json(await facilitator.verify(r.payload, r.requirements));
    } catch (err) {
      log.error('facilitator-server: verify threw', err);
      res.status(500).json({ error: (err as Error)?.message ?? 'internal error' });
    }
  });

  router.post('/settle', json, async (req: Request, res: Response) => {
    const r = readRequest(req, res);
    if (!r) return;
    let response: SettlementResponse;
    try {
      response = await facilitator.settle(r.payload, r.requirements);
    } catch (err) {
      log.error('facilitator-server: settle threw', err);
      res.status(500).json({ error: (err as Error)?.message ?? 'internal error' });
      return;
    }
    res.json(response);
    if (opts.onSettle) {
      Promise.resolve()
        .then(() => opts.onSettle!(response, req))
        .catch(err => log.warn('facilitator-server: onSettle hook failed (non-fatal):', err));
    }
  });

  router.get('/supported', async (_req: Request, res: Response) => {
    if (!facilitator.supported) {
      res.status(501).json({ error: 'facilitator does not implement supported()' });
      return;
    }
    try {
      res.json(await facilitator.supported());
    } catch (err) {
      log.error('facilitator-server: supported() threw', err);
      res.status(500).json({ error: (err as Error)?.message ?? 'internal error' });
    }
  });

  // Probes carry no credentials, so healthz sits before the auth middleware.
  const outer = express.Router();
  outer.get('/healthz', (_req: Request, res: Response) => { res.json({ ok: true }); });
  outer.use(router);
  return outer;
}
