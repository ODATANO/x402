/**
 * CAP-backed time-limited grants.
 *
 * Used by `gateService` when its `grants` option is set. The accepted-
 * payment hook issues a grant token + expiry, returns the token via
 * the `X-PAYMENT-GRANT` response header. The before-* hook checks the
 * inbound `X-PAYMENT-GRANT` header against the table, route-scoped and
 * time-windowed; a valid grant bypasses the 402 + verify+settle pipeline.
 *
 * Trade-offs vs. JWT:
 *   - Opaque tokens require one DB lookup per request, JWT would be
 *     self-validating. We prefer opaque so revocation is trivial
 *     (`DELETE FROM X402Grants WHERE token = …`) and clock skew is a
 *     non-issue (the DB owns `now`).
 *   - Lookup adds latency (~ms on SQLite, < ms on HANA). Negligible
 *     compared to the seconds-long settle path it replaces.
 *
 * Failure modes:
 *   - Issue failure: logged, gate still serves the response (the buyer
 *     paid, we don't punish them for our DB hiccup). They simply won't
 *     have a grant for next time.
 *   - Lookup failure: treated as `not-found`; the gate falls through to
 *     the normal payment path. Buyers retry their grant; on real DB
 *     failures, payments still work, just without the subscription
 *     short-circuit.
 */

import cds from '@sap/cds';
import { randomBytes } from 'crypto';
import type { PaymentClaim } from '../core/types';

const log = cds.log('x402');

export const DEFAULT_GRANTS_ENTITY = 'odatano.x402.X402Grants';
export const DEFAULT_GRANT_TTL_SECONDS = 3600;

/** Resolve entity name from the `grants` option. */
export function resolveGrantsEntity(
  grants: boolean | { ttlSeconds?: number; entity?: string } | undefined,
): string | null {
  if (!grants) return null;
  if (grants === true) return DEFAULT_GRANTS_ENTITY;
  return grants.entity ?? DEFAULT_GRANTS_ENTITY;
}

/** Resolve TTL (seconds) from the `grants` option. */
export function resolveGrantTtl(
  grants: boolean | { ttlSeconds?: number; entity?: string } | undefined,
): number {
  if (!grants || grants === true) return DEFAULT_GRANT_TTL_SECONDS;
  return grants.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
}

function generateToken(): string {
  // 32 bytes, base64url-encoded (44 chars without padding).
  return randomBytes(32).toString('base64url');
}

export interface IssueGrantResult {
  token: string;
  expiresAt: string; // ISO-8601
}

/**
 * Issue a new grant for an accepted payment. Returns `null` if the
 * INSERT failed; the caller continues without setting the
 * `X-PAYMENT-GRANT` response header (graceful degradation).
 */
export async function issueGrant(
  entityName: string,
  claim: PaymentClaim,
  route: string,
  ttlSeconds: number,
): Promise<IssueGrantResult | null> {
  const token = generateToken();
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();

  try {
    await INSERT.into(entityName).entries({
      ID:        cds.utils.uuid(),
      token,
      route,
      payerAddr: claim.payerAddr ?? null,
      txHash:    claim.txHash,
      asset:     claim.asset,
      network:   claim.network,
      issuedAt:  new Date(now).toISOString(),
      expiresAt,
    });
    return { token, expiresAt };
  } catch (err) {
    log.warn(
      `x402 grant INSERT into ${entityName} failed (non-fatal):`,
      (err as { message?: string })?.message ?? err,
    );
    return null;
  }
}

export type GrantLookupResult =
  | { kind: 'valid' }
  | { kind: 'expired' }
  | { kind: 'not-found' };

/**
 * Look up a grant by token, scoped to a specific route. The route check
 * is strict equality, a grant for `/Quotes` will not unlock `/getBestPrice`.
 * Any DB error is logged and surfaces as `not-found`; the gate then runs
 * its normal payment path, ensuring DB problems never deny paying buyers.
 */
export async function lookupGrant(
  entityName: string,
  token: string,
  route: string,
): Promise<GrantLookupResult> {
  if (!token) return { kind: 'not-found' };

  try {
    const row = await SELECT.one
      .from(entityName)
      .where({ token, route }) as { expiresAt?: string } | null;

    if (!row) return { kind: 'not-found' };
    const expiresMs = row.expiresAt ? Date.parse(row.expiresAt) : 0;
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return { kind: 'expired' };
    }
    return { kind: 'valid' };
  } catch (err) {
    log.warn(
      `x402 grant SELECT from ${entityName} failed (non-fatal):`,
      (err as { message?: string })?.message ?? err,
    );
    return { kind: 'not-found' };
  }
}
