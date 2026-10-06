/**
 * Requirements a resource server offered, kept until they expire. Needed
 * when a route's requirements differ per request (e.g. a datum per order):
 * the paid retry is matched against what was offered, not re-priced.
 */

import { requirementsKey } from '../core/match';
import type { PaymentRequirements } from '../core/types';

export interface IssuedRequirementsStore {
  /** Remember the entries offered for `resourceUrl` until `expiresAt` (POSIX ms). */
  save(resourceUrl: string, accepts: PaymentRequirements[], expiresAt: number): Promise<void>;
  /** The entry offered for `resourceUrl` that equals `accepted`, or undefined. */
  find(resourceUrl: string, accepted: PaymentRequirements): Promise<PaymentRequirements | undefined>;
}

/** In-process store; several instances need a shared one. */
export function memoryIssuedRequirementsStore(): IssuedRequirementsStore {
  const entries = new Map<string, { requirements: PaymentRequirements; expiresAt: number }>();
  const keyOf = (url: string, r: PaymentRequirements) => `${url}\n${requirementsKey(r)}`;

  return {
    async save(resourceUrl, accepts, expiresAt) {
      const now = Date.now();
      for (const [k, v] of entries) if (v.expiresAt <= now) entries.delete(k);
      for (const r of accepts) entries.set(keyOf(resourceUrl, r), { requirements: r, expiresAt });
    },
    async find(resourceUrl, accepted) {
      const hit = entries.get(keyOf(resourceUrl, accepted));
      return hit && hit.expiresAt > Date.now() ? hit.requirements : undefined;
    },
  };
}
