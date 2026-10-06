/**
 * Settlement claims per canonical transaction id (Cardano `exact`,
 * "Duplicate Settlement Mitigation"). A claim is taken atomically before
 * the first submit, so two concurrent settles of one transaction cannot
 * both deliver. It is kept until the transaction can no longer land.
 */

import type { SettlementResponse } from '../core/types';

/**
 * `submitting`: one settle call is working on the transaction, until its lease runs out.
 * `pending`: not yet confirmed, nobody working; a retry may resume.
 */
export type SettlementState = 'submitting' | 'pending' | 'settled' | 'failed';

export interface SettlementRecord {
  txId: string;
  state: SettlementState;
  /** POSIX ms after which the record may be dropped. */
  expiresAt: number;
  /** POSIX ms; while `submitting`, the working call holds the claim until then. */
  leaseUntil?: number;
  /** True once a backend took the transaction; it is then never submitted again. */
  broadcast: boolean;
  /** Last answer given for this transaction. */
  response?: SettlementResponse;
}

export type ClaimResult =
  | { claimed: true }
  | { claimed: false; record: SettlementRecord };

/**
 * Storage for settlement claims. Several instances serving `/settle` for
 * the same payees must share one store, or a pending retry that lands on
 * another instance will not find its claim.
 */
export interface SettlementStore {
  /** Take the claim for `txId` as `submitting`, or return the record that already holds it. Atomic. */
  claim(txId: string, expiresAt: number, leaseUntil: number): Promise<ClaimResult>;
  get(txId: string): Promise<SettlementRecord | undefined>;
  /**
   * Take over a record nobody works on: `pending`, or `submitting` with a
   * lease that ran out (its call died). Atomic; false when someone else did.
   */
  resume(txId: string, leaseUntil: number): Promise<boolean>;
  update(txId: string, patch: Partial<Omit<SettlementRecord, 'txId'>>): Promise<void>;
  /** Drop the claim: only when the ledger refused the transaction. */
  release(txId: string): Promise<void>;
}

/** True when a retry may take the record over. */
export function isResumable(record: SettlementRecord, now = Date.now()): boolean {
  return record.state === 'pending'
    || (record.state === 'submitting' && (record.leaseUntil ?? 0) <= now);
}

/** In-process store; enough for a single facilitator instance. */
export function memorySettlementStore(): SettlementStore {
  const records = new Map<string, SettlementRecord>();

  function live(txId: string): SettlementRecord | undefined {
    const r = records.get(txId);
    if (r && r.expiresAt <= Date.now()) {
      records.delete(txId);
      return undefined;
    }
    return r;
  }

  // No method awaits before its map write, so each is one step for the event loop.
  return {
    async claim(txId, expiresAt, leaseUntil) {
      const now = Date.now();
      for (const [id, r] of records) if (r.expiresAt <= now) records.delete(id);
      const existing = live(txId);
      if (existing) return { claimed: false, record: { ...existing } };
      records.set(txId, { txId, state: 'submitting', expiresAt, leaseUntil, broadcast: false });
      return { claimed: true };
    },
    async get(txId) {
      const r = live(txId);
      return r ? { ...r } : undefined;
    },
    async resume(txId, leaseUntil) {
      const r = live(txId);
      if (!r || !isResumable(r)) return false;
      records.set(txId, { ...r, state: 'submitting', leaseUntil });
      return true;
    },
    async update(txId, patch) {
      const r = live(txId);
      if (r) records.set(txId, { ...r, ...patch });
    },
    async release(txId) {
      records.delete(txId);
    },
  };
}
