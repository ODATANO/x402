/**
 * `SettlementStore` on a CDS entity (`odatano.x402.X402Settlements` by
 * default, shipped in `db/x402-settlements.cds`). Use it when several
 * instances serve payments for the same payees. Every statement commits
 * on its own, so a claim survives a rolled-back request.
 */

import cds from '@sap/cds';
import type { X402Settlement } from '#cds-models/odatano/x402';
import { runDetached } from '../helpers/db';
import type { SettlementResponse } from '../core/types';
import type { ClaimResult, SettlementRecord, SettlementStore } from './store';

export const DEFAULT_SETTLEMENTS_ENTITY = 'odatano.x402.X402Settlements';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

/** A row as read; key, state, expiry and broadcast are never null for rows this store wrote. */
type SettlementRow =
  Required<Pick<X402Settlement, 'txId' | 'state' | 'expiresAt' | 'broadcast'>>
  & Pick<X402Settlement, 'leaseUntil' | 'response'>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Parse the `response` column; undefined for an empty or unreadable value. */
function parseResponse(json: string | null | undefined): SettlementResponse | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as SettlementResponse;
  } catch {
    return undefined;
  }
}

function toRecord(row: SettlementRow): SettlementRecord {
  const response = parseResponse(row.response);
  return {
    txId:      row.txId,
    state:     row.state,
    expiresAt: Date.parse(row.expiresAt),
    ...(row.leaseUntil ? { leaseUntil: Date.parse(row.leaseUntil) } : {}),
    broadcast: Boolean(row.broadcast),
    ...(response ? { response } : {}),
  };
}

export function cdsSettlementStore(entity: string = DEFAULT_SETTLEMENTS_ENTITY): SettlementStore {
  const read = (txId: string) =>
    runDetached<SettlementRow | null>(SELECT.one.from(entity).where({ txId }));

  return {
    async claim(txId, expiresAt, leaseUntil): Promise<ClaimResult> {
      await runDetached(DELETE.from(entity).where({ expiresAt: { '<': iso(Date.now()) } }));
      try {
        await runDetached(INSERT.into(entity).entries({
          txId, state: 'submitting', expiresAt: iso(expiresAt), leaseUntil: iso(leaseUntil), broadcast: false, response: null,
        }));
        return { claimed: true };
      } catch (err) {
        const row = await read(txId);
        if (!row) throw err;
        return { claimed: false, record: toRecord(row) };
      }
    },

    async get(txId) {
      const row = await read(txId);
      return row && Date.parse(row.expiresAt) > Date.now() ? toRecord(row) : undefined;
    },

    async resume(txId, leaseUntil) {
      const take = { state: 'submitting', leaseUntil: iso(leaseUntil) };
      const fromPending = await runDetached<number>(
        UPDATE.entity(entity).set(take).where({ txId, state: 'pending' }),
      );
      if (Number(fromPending) === 1) return true;
      const fromDeadCall = await runDetached<number>(
        UPDATE.entity(entity).set(take).where({ txId, state: 'submitting', leaseUntil: { '<': iso(Date.now()) } }),
      );
      return Number(fromDeadCall) === 1;
    },

    async update(txId, patch) {
      await runDetached(UPDATE.entity(entity).set({
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: iso(patch.expiresAt) } : {}),
        ...(patch.leaseUntil !== undefined ? { leaseUntil: iso(patch.leaseUntil) } : {}),
        ...(patch.broadcast !== undefined ? { broadcast: patch.broadcast } : {}),
        ...(patch.response !== undefined ? { response: JSON.stringify(patch.response) } : {}),
      }).where({ txId }));
    },

    async release(txId) {
      await runDetached(DELETE.from(entity).where({ txId }));
    },
  };
}
