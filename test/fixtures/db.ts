/**
 * A real in-memory sqlite with the plugin's entities, for tests of the
 * modules that persist (settlement claims, receipts, grants). Mocked query
 * builders would not catch a wrong column or a statement that joins the
 * request's transaction.
 */

import cds from '@sap/cds';

const MODEL_FILES = ['db/x402-settlements.cds', 'db/x402-receipts.cds', 'db/x402-grants.cds'];

// `cds.deploy` and `disconnect` exist at runtime but are missing from the published cds types.
const deploy = (cds as unknown as { deploy(csn: unknown): { to(db: unknown): Promise<unknown> } }).deploy;
type Disconnectable = { disconnect?(): Promise<void> };

/** Deploy the entities to a fresh in-memory database and make it `cds.db`. */
export async function deployTestDb(): Promise<void> {
  const csn = await cds.load(MODEL_FILES);
  cds.model = cds.compile.for.nodejs(csn);
  cds.db = await cds.connect.to('db', { kind: 'sqlite', credentials: { url: ':memory:' } });
  await deploy(csn).to(cds.db);
}

export async function closeTestDb(): Promise<void> {
  await (cds.db as unknown as Disconnectable | undefined)?.disconnect?.();
}

/** All rows of an entity, read in a transaction of its own. */
export function rowsOf<T = Record<string, unknown>>(entity: string): Promise<T[]> {
  return cds.tx(tx => tx.run(cds.ql.SELECT.from(entity))) as Promise<T[]>;
}
