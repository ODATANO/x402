/**
 * Express middleware for x402 payment gating (Cardano `exact`).
 *
 * Mount on a route or service path to gate every request beneath it.
 * `skipPaths` carves out paths buyers must reach unpaid (OData
 * `$metadata`, root, ...).
 *
 * Flow per request (`authorization`): verify the payment, run the
 * handler with its response held back, settle, then send the response
 * with `PAYMENT-RESPONSE`. A handler answering >= 400 is not settled.
 * Streaming handlers are buffered until settlement.
 */

import cds from '@sap/cds';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { defaultFacilitator, type Facilitator } from '../facilitator/adapter';
import { resolvePrice } from './pricing';
import { startPayment, finishPayment, type HttpAnswer, type PaymentGateOptions } from './flow';
import type {
  PaymentClaim,
  PriceSpec,
  PriceResolver,
  PricingContext,
} from '../core/types';

// `req.payment` is the verified payment while the handler runs; it is
// settled before the response leaves.
declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Request {
    payment?: PaymentClaim;
  }
}

const log = cds.log('x402');

export interface X402MiddlewareOptions extends PaymentGateOptions {
  /**
   * Single price for everything under this mount: scalar, `RouteOption`
   * or `RouteOption[]`. `routePricing` wins where it matches.
   */
  priceUnits?: PriceSpec;
  /**
   * Per-route prices keyed by the URL's last segment, or a `PriceResolver`.
   * A resolver returning `null` passes the request through.
   */
  routePricing?: Record<string, PriceSpec> | PriceResolver;
  /** default: $metadata, $batch, root, /index */
  skipPaths?: RegExp;
  /** Audit callback after settlement; errors are logged, never block the response. */
  onAccepted?: (claim: PaymentClaim, req: Request) => void | Promise<void>;
  /** default: the process-wide `defaultFacilitator()` */
  facilitator?: Facilitator;
}

function expressContext(req: Request): PricingContext {
  // Last URL segment with OData function args stripped:
  //   /odata/v4/price/getBestPrice(pair='ADA-USD') → getBestPrice
  const segment = (req.path.split('/').pop() ?? '').split('(')[0] ?? '';
  return {
    event:   segment,
    path:    req.path,
    method:  req.method,
    headers: req.headers as Record<string, string | string[] | undefined>,
    query:   req.query as Record<string, string | string[] | undefined>,
  };
}

function send(res: Response, answer: HttpAnswer): void {
  for (const [k, v] of Object.entries(answer.headers)) res.setHeader(k, v);
  res.status(answer.status).json(answer.body);
}

type ChunkArg = string | Uint8Array | undefined;

/**
 * Hold the handler's response: `writeHead`, `write` and `end` are captured
 * until `release` decides to send it or replace it.
 */
function holdResponse(res: Response, onEnd: (release: (replace?: HttpAnswer, headers?: Record<string, string>) => void) => void): void {
  const chunks: Buffer[] = [];
  // Headers set before the handler ran; a replacement answer keeps only these.
  const ownHeaders = new Set(res.getHeaderNames());
  const origWriteHead = res.writeHead.bind(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let head: { status: number; headers?: Record<string, string | number | string[]> } | undefined;

  const collect = (chunk: ChunkArg, encoding?: unknown) => {
    if (chunk === undefined || chunk === null) return;
    chunks.push(typeof chunk === 'string'
      ? Buffer.from(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
      : Buffer.from(chunk));
  };

  (res as unknown as { writeHead: unknown }).writeHead = (status: number, a?: unknown, b?: unknown) => {
    const headers = (typeof a === 'object' && a !== null ? a : b) as Record<string, string | number | string[]> | undefined;
    head = { status, ...(headers ? { headers } : {}) };
    return res;
  };
  (res as unknown as { write: unknown }).write = (chunk: ChunkArg, encoding?: unknown, cb?: unknown) => {
    collect(chunk, encoding);
    const done = typeof encoding === 'function' ? encoding : cb;
    if (typeof done === 'function') (done as () => void)();
    return true;
  };
  (res as unknown as { end: unknown }).end = (chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    if (typeof chunk !== 'function') collect(chunk as ChunkArg, encoding);
    res.writeHead = origWriteHead;
    res.write = origWrite;
    res.end = origEnd;
    if (head) {
      res.statusCode = head.status;
      for (const [k, v] of Object.entries(head.headers ?? {})) res.setHeader(k, v);
    }
    onEnd((replace, headers) => {
      for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
      if (replace) {
        const keep = new Set([...ownHeaders, ...Object.keys(headers ?? {}).map(h => h.toLowerCase())]);
        for (const name of res.getHeaderNames()) if (!keep.has(name)) res.removeHeader(name);
        send(res, replace);
        return;
      }
      origEnd(Buffer.concat(chunks));
      const done = [chunk, encoding, cb].find(x => typeof x === 'function');
      if (done) (done as () => void)();
    });
    return res;
  };
}

/** Build the Express middleware. */
export function x402Middleware(opts: X402MiddlewareOptions): RequestHandler {
  if (!opts.payTo)   throw new Error('x402Middleware: payTo is required');
  if (!opts.network) throw new Error('x402Middleware: network is required');
  if (!opts.asset)   throw new Error('x402Middleware: asset is required');
  if (opts.priceUnits == null && !opts.routePricing) {
    throw new Error('x402Middleware: priceUnits or routePricing is required');
  }
  const skipPaths   = opts.skipPaths ?? /(^\/?$|\$metadata|\$batch|^\/?\?|^\/index)/i;
  const facilitator = opts.facilitator ?? defaultFacilitator();

  return async function x402Express(req: Request, res: Response, next: NextFunction) {
    try {
      if (skipPaths.test(req.path)) return next();

      const options = await resolvePrice(opts, expressContext(req));
      if (options == null) return next(); // unmapped path = pass through

      const header = req.headers['payment-signature'];
      const started = await startPayment(
        opts, facilitator, options, req.originalUrl ?? req.url, Array.isArray(header) ? header[0] : header,
      );
      if (started.kind === 'answer') return send(res, started.answer);

      const session = started.session;
      req.payment = session.claim;
      holdResponse(res, (release) => {
        // A failed handler is not settled: the buyer keeps the money.
        if (res.statusCode >= 400) return release();
        finishPayment(facilitator, session).then(async (finished) => {
          if (finished.kind === 'answer') return release(finished.answer);
          req.payment = finished.claim;
          if (opts.onAccepted) {
            try { await opts.onAccepted(finished.claim, req); }
            catch (err) { log.warn('onAccepted callback failed (non-fatal):', (err as Error)?.message ?? err); }
          }
          release(undefined, finished.headers);
        }).catch((err) => {
          log.error('x402 settle failed', err);
          release({ status: 500, headers: {}, body: { error: 'x402 settlement error' } });
        });
      });
      next();
    } catch (err) {
      log.error('x402 middleware failed', err);
      next(err);
    }
  };
}
