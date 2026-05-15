/**
 * CAP-backed persistence for accepted x402 payments.
 *
 * Called from `gateService` when its `receipts` option is set. One INSERT
 * per accepted payment; runs AFTER settle confirms and BEFORE the 200
 * response is served to the buyer. Best-effort: any INSERT failure is
 * logged and SWALLOWED, the canonical record is on chain and we never
 * want a flaky DB to deny a paying buyer their response.
 *
 * Entity shape: see `db/x402-receipts.cds`. The schema is shipped in the
 * plugin's `db/`; CAP auto-discovers it when `@odatano/x402` is in
 * node_modules. Consumers wanting a custom shape can pass
 * `receipts: { entity: 'my.namespace.MyTable' }`, the table needs to
 * carry the columns we INSERT below.
 *
 * Idempotency: txHash carries `@assert.unique`. A duplicate INSERT
 * (e.g. settle returning twice for the same buyer) hits a unique-key
 * violation and we log + continue. Buyers' UX is unaffected.
 */

import cds from '@sap/cds';
import type { PaymentClaim } from '../core/types';

const log = cds.log('x402');

/** Canonical entity name shipped by the plugin. */
export const DEFAULT_RECEIPTS_ENTITY = 'odatano.x402.X402Receipts';

/**
 * Insert one receipt for an accepted payment. Returns a promise that
 * always resolves (never throws), errors are logged.
 *
 * The `route` argument is the resource URL the buyer paid for, the same
 * value embedded in `accepts[0].resource.url`. We pass it explicitly
 * rather than re-deriving it inside this module so the persisted route
 * matches what the 402 advertised, even when the consumer set a custom
 * `resourceUrl` builder.
 */
export async function persistReceipt(
  entityName: string,
  claim: PaymentClaim,
  route: string,
): Promise<void> {
  try {
    await INSERT.into(entityName).entries({
      ID:        cds.utils.uuid(),
      txHash:    claim.txHash,
      payerAddr: claim.payerAddr ?? null,
      payTo:     claim.payTo,
      asset:     claim.asset,
      amount:    claim.amountUnits,
      network:   claim.network,
      route,
      nonceRef:  claim.nonceRef,
      at:        new Date().toISOString(),
    });
  } catch (err) {
    log.warn(
      `x402 receipts INSERT into ${entityName} failed (non-fatal):`,
      (err as { message?: string })?.message ?? err,
    );
  }
}

/** Resolve the entity name from the `receipts` option. */
export function resolveReceiptsEntity(
  receipts: boolean | { entity?: string } | undefined,
): string | null {
  if (!receipts) return null;
  if (receipts === true) return DEFAULT_RECEIPTS_ENTITY;
  return receipts.entity ?? DEFAULT_RECEIPTS_ENTITY;
}
