/**
 * Match the buyer's `accepted` against the requirements the server offers.
 * The Cardano `exact` spec requires an exact match; only the network may
 * differ in form (CIP-34 alias vs canonical id).
 */

import { normalizeNetwork } from './network';
import type { PaymentRequirements } from './types';

/** JSON with object keys sorted, so key order does not affect equality. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Key that is equal for two requirements exactly when they match. */
export function requirementsKey(r: PaymentRequirements): string {
  return canonicalJson({ ...r, network: normalizeNetwork(r.network) ?? r.network });
}

/** The offered entry `accepted` equals, or undefined. */
export function findAcceptedRequirements(
  accepted: PaymentRequirements,
  offered: readonly PaymentRequirements[],
): PaymentRequirements | undefined {
  const key = requirementsKey(accepted);
  return offered.find(r => requirementsKey(r) === key);
}
