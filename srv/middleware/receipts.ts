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
 * Idempotency: txHash is unique in the entity. A duplicate INSERT
 * (e.g. settle returning twice for the same buyer) hits a unique-key
 * violation and we log + continue. Buyers' UX is unaffected.
 */

import cds from '@sap/cds';
import { runDetached } from '../helpers/db';
import type { PaymentClaim } from '../core/types';

const log = cds.log('x402');

/** Canonical entity name shipped by the plugin. */
export const DEFAULT_RECEIPTS_ENTITY = 'odatano.x402.X402Receipts';

/**
 * Insert one receipt for a settled payment, in a transaction of its own.
 * Never throws; errors are logged. `route` is the resource URL the 402
 * advertised.
 */
export async function persistReceipt(
  entityName: string,
  claim: PaymentClaim,
  route: string,
): Promise<void> {
  try {
    await runDetached(cds.ql.INSERT.into(entityName).entries({
      id:        cds.utils.uuid(),
      txHash:    claim.txHash,
      payerAddr: claim.payerAddr ?? null,
      payTo:     claim.payTo,
      asset:     claim.asset,
      amount:    claim.amountUnits,
      network:   claim.network,
      route,
      nonceRef:  claim.nonceRef,
      at:        new Date().toISOString(),
    }));
  } catch (err) {
    log.warn(
      `x402 receipts INSERT into ${entityName} failed (non-fatal):`,
      (err as { message?: string })?.message ?? err,
    );
  }
}
