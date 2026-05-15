/**
 * Shared pricing resolution for the CAP and Express middlewares.
 *
 * The two integrations differ in how they extract the routing key
 * (`req.event` vs. last URL segment) and how they read headers, but
 * once they've built a `PricingContext` the resolution logic is identical:
 *
 *   1. If `routePricing` is a function, invoke it with the context.
 *      Sync or async; null return = pass through.
 *   2. If `routePricing` is a static map, look up `target` then `event`.
 *      Miss falls back to `priceUnits`. Both miss = pass through.
 *   3. The matched value can be a scalar (single price in default asset),
 *      a `RouteOption` (single price with overrides), or `RouteOption[]`
 *      (multi-accept). Scalars and single RouteOptions are widened to
 *      length-1 arrays so downstream code only deals with one shape.
 *
 * Returns `RouteOption[]` (≥ 1 entry) or `null` for pass-through.
 *
 * The middlewares pass the returned array straight to
 * `buildPaymentRequirementsMulti()`; length-1 still produces a single-
 * entry 402 body, indistinguishable from the pre-v0.3 output.
 */

import type {
  PriceSpec,
  PriceResolver,
  PricingContext,
  RouteOption,
} from '../core/types';

export interface PricingOptions {
  /** Single price, applies when `routePricing` misses. */
  priceUnits?: PriceSpec;
  /**
   * Per-event prices keyed by route name, OR a dynamic resolver function.
   * Function returns null to skip the gate entirely.
   */
  routePricing?: Record<string, PriceSpec> | PriceResolver;
}

function widenToOptions(spec: PriceSpec): RouteOption[] {
  if (Array.isArray(spec)) {
    if (spec.length === 0) {
      throw new Error('resolvePrice: route option array must be non-empty');
    }
    return spec;
  }
  if (typeof spec === 'object') {
    // RouteOption shape
    return [spec];
  }
  // scalar (string | number | bigint) , default-asset shorthand
  return [{ amount: spec }];
}

function lookupStatic(
  map: Record<string, PriceSpec>,
  ctx: PricingContext,
): PriceSpec | undefined {
  // `target` is more specific (CAP entity name) than `event` (verb), so
  // try the entity segment first. Express only fills `event`.
  if (ctx.target) {
    const entitySegment = ctx.target.split('.').pop() ?? '';
    if (entitySegment && map[entitySegment] != null) return map[entitySegment];
  }
  if (map[ctx.event] != null) return map[ctx.event];
  return undefined;
}

/**
 * Resolve pricing for a request. Returns the option array to gate the
 * request with, or `null` if the request should pass through ungated.
 *
 * Async to support dynamic resolvers that hit a DB / cache. Awaiting a
 * sync return is a JS-engine no-op, so the sync path stays fast.
 */
export async function resolvePrice(
  opts: PricingOptions,
  ctx: PricingContext,
): Promise<RouteOption[] | null> {
  // ─── 1. Function-form routePricing ─────────────────────────────────
  if (typeof opts.routePricing === 'function') {
    const spec = await opts.routePricing(ctx);
    if (spec == null) return null;
    return widenToOptions(spec);
  }

  // ─── 2. Static-map routePricing ────────────────────────────────────
  if (opts.routePricing) {
    const hit = lookupStatic(opts.routePricing, ctx);
    if (hit != null) return widenToOptions(hit);
    // Map present but no key matched. Fall through to priceUnits.
  }

  // ─── 3. Fallback to flat priceUnits ────────────────────────────────
  if (opts.priceUnits != null) return widenToOptions(opts.priceUnits);
  return null;
}
