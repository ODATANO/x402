/**
 * Database access of the payment gate. Every statement runs in its own
 * transaction, committed at once: the gate's records (claims, receipts,
 * grants) must not depend on the fate of the request's transaction.
 */

import cds from '@sap/cds';

/** Run one query in a transaction of its own. */
export function runDetached<T = unknown>(query: object): Promise<T> {
  return cds.tx(tx => tx.run(query as never)) as Promise<T>;
}

/** Entity name of a `true | { entity }` option; null when the option is off. */
export function entityOption(option: boolean | { entity?: string } | undefined, defaultEntity: string): string | null {
  if (!option) return null;
  return option === true ? defaultEntity : option.entity ?? defaultEntity;
}
