/**
 * Express middleware factory for Cardano-x402 payment gating.
 *
 * Mount on a route or service path to gate every request beneath it.
 * The `skipPaths` regex carves out paths buyers MUST be able to fetch
 * without paying (e.g. OData `$metadata`, `$batch` previews).
 *
 * Two pricing modes:
 *   1. `priceUnits`   — single price for everything under this mount.
 *   2. `routePricing` — { 'EntityOrActionName': 'priceUnits' }, keyed
 *                       by the last URL segment (with OData function
 *                       args stripped). Unmapped paths pass through.
 *
 * The 402 body is the canonical v2 shape (`x402Version: 2`, `accepts[]`,
 * etc). When the rejection has a more specific cause than "missing
 * header", we append `(code): reason` to the `error` string so clients
 * can extract the code without breaking wire format.
 */

import cds from '@sap/cds';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { buildPaymentRequirements } from '../core/requirements';
import { process as processX402 } from '../facilitator/verify';
import { Codes } from '../core/errors';
import type { AssetTransferMethod, PaymentClaim, Network } from '../core/types';

// Augment Express's Request so handlers downstream can read `req.payment`
// after the middleware accepts a payment.
declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Request {
    payment?: PaymentClaim;
  }
}

const log = cds.log('x402');

export interface X402MiddlewareOptions {
  /** Bech32 recipient. */
  payTo: string;
  /** v2 network identifier. */
  network: Network | string;
  /** v2 asset string: 'lovelace' or '<policy>.<nameHex>'. */
  asset: string;
  /**
   * Single price for everything under this mount. Mutually exclusive
   * with `routePricing` (but coexistable: routePricing wins where
   * defined, falls back to priceUnits otherwise).
   */
  priceUnits?: string | number | bigint;
  /** Per-route prices keyed by the URL's last segment. */
  routePricing?: Record<string, string | number | bigint>;
  /** Regex of paths that bypass payment (default: $metadata, $batch, root, /index). */
  skipPaths?: RegExp;
  /** Shown in `accepts[0].resource.description`. */
  description?: string;
  /** Override default `accepts[0].resource.mimeType` ('application/json'). */
  mimeType?: string;
  /** v2 `assetTransferMethod`. Default 'default'. */
  assetTransferMethod?: AssetTransferMethod;
  /** Buyer-side timeout hint. Default 600. */
  maxTimeoutSeconds?: number;
  /** Free-form extras (decimals, fingerprint, UI hints). */
  extra?: Record<string, unknown>;
  /** Settle poll budget (ms). Default 60_000. */
  settlePollBudgetMs?: number;
  /** If true, accept tx with no TTL set. Default false (spec-strict). */
  allowNoTtl?: boolean;
  /**
   * Audit / persistence callback. Invoked exactly once per accepted
   * payment, after settle confirms. Errors here are logged but never
   * block serving the response.
   */
  onAccepted?: (claim: PaymentClaim, req: Request) => void | Promise<void>;
}

function pickPriceUnits(req: Request, opts: X402MiddlewareOptions): string | null {
  if (opts.routePricing) {
    // Last URL segment, OData function-args stripped:
    //   /odata/v4/price/getBestPrice(pair='ADA-USD') → getBestPrice
    const segment = (req.path.split('/').pop() ?? '').split('(')[0]!;
    const price = opts.routePricing[segment];
    if (price != null) return String(price);
    if (opts.priceUnits != null) return String(opts.priceUnits);
    return null; // unmapped under routePricing = pass through
  }
  return opts.priceUnits != null ? String(opts.priceUnits) : null;
}

/** Build the Express middleware. */
export function x402Middleware(opts: X402MiddlewareOptions): RequestHandler {
  if (!opts.payTo)   throw new Error('x402Middleware: payTo is required');
  if (!opts.network) throw new Error('x402Middleware: network is required');
  if (!opts.asset)   throw new Error('x402Middleware: asset is required');
  if (opts.priceUnits == null && !opts.routePricing) {
    throw new Error('x402Middleware: priceUnits or routePricing is required');
  }
  const skipPaths = opts.skipPaths ?? /(^\/?$|\$metadata|\$batch|^\/?\?|^\/index)/i;

  return async function x402Express(req: Request, res: Response, next: NextFunction) {
    try {
      if (skipPaths.test(req.path)) return next();

      const priceUnits = pickPriceUnits(req, opts);
      if (priceUnits == null) return next(); // unmapped path = pass through

      const requirementsBody = buildPaymentRequirements({
        amount: priceUnits,
        asset: opts.asset,
        payTo: opts.payTo,
        network: opts.network,
        resource: {
          url: req.originalUrl ?? req.url,
          description: opts.description ?? '',
          mimeType: opts.mimeType ?? 'application/json',
        },
        ...(opts.assetTransferMethod ? { assetTransferMethod: opts.assetTransferMethod } : {}),
        ...(opts.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}),
        ...(opts.extra ? { extra: opts.extra } : {}),
        withMissingHeaderError: true,
      });

      const headerVal = req.headers['payment-signature'];
      const processArgs: Parameters<typeof processX402>[0] = {
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

      const result = await processX402(processArgs);

      if (result.kind === 'accepted') {
        res.setHeader('X-PAYMENT-RESPONSE', result.paymentResponseB64);
        req.payment = result.payment;
        return next();
      }

      // rejected | pending → 402
      const body: Record<string, unknown> = { ...result.requirementsBody };
      const baseError = (result.requirementsBody.error ?? 'payment required').toString();
      if (result.code && result.code !== Codes.MISSING_HEADER) {
        body.error = `${baseError} (${result.code}): ${result.reason ?? ''}`.trim();
      }
      if (result.kind === 'pending') {
        // Add the spec-defined "pending" markers so the buyer can poll.
        body.pending = true;
        if (result.txHash) body.transaction = result.txHash;
      }
      res.status(402).json(body);
    } catch (err) {
      log.error('x402 middleware failed', err);
      next(err);
    }
  };
}
