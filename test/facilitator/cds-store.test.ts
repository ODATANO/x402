/**
 * cdsSettlementStore against a real in-memory sqlite: the statements, the
 * columns and the fact that every statement commits on its own.
 */

import cds from '@sap/cds';
import { cdsSettlementStore, DEFAULT_SETTLEMENTS_ENTITY } from '../../srv/facilitator/cds-store';
import { deployTestDb, closeTestDb, rowsOf } from '../fixtures/db';

const TX = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const later = () => Date.now() + 60_000;

interface Row {
  txId: string;
  state: string;
  expiresAt: string;
  leaseUntil: string | null;
  broadcast: boolean | number;
  response: string | null;
}

const rows = () => rowsOf<Row>(DEFAULT_SETTLEMENTS_ENTITY);
const run = (query: object) => cds.tx(tx => tx.run(query as never));

beforeAll(deployTestDb);
afterAll(closeTestDb);
beforeEach(() => run(cds.ql.DELETE.from(DEFAULT_SETTLEMENTS_ENTITY)));

describe('cdsSettlementStore, claim', () => {
  it('inserts a submitting row with its lease and no broadcast', async () => {
    const store = cdsSettlementStore();
    const expiresAt = later();
    const leaseUntil = Date.now() + 5_000;
    expect(await store.claim(TX, expiresAt, leaseUntil)).toEqual({ claimed: true });

    const [row] = await rows();
    expect(row).toMatchObject({ txId: TX, state: 'submitting', response: null });
    expect(Boolean(row!.broadcast)).toBe(false);
    expect(await store.get(TX)).toEqual({ txId: TX, state: 'submitting', expiresAt, leaseUntil, broadcast: false });
  });

  it('returns the existing record to a second claim', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    const second = await store.claim(TX, later(), later());
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.record).toMatchObject({ txId: TX, state: 'submitting', broadcast: false });
    expect(await rows()).toHaveLength(1);
  });

  it('gives the claim to exactly one of two concurrent callers', async () => {
    const store = cdsSettlementStore();
    const [a, b] = await Promise.all([store.claim(TX, later(), later()), store.claim(TX, later(), later())]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
  });

  it('keeps the claim when the surrounding transaction fails', async () => {
    const store = cdsSettlementStore();
    await expect(cds.tx(async () => {
      await store.claim(TX, later(), later());
      throw new Error('request rejected');
    })).rejects.toThrow('request rejected');
    expect((await store.get(TX))?.state).toBe('submitting');
  });

  it('purges expired rows on a claim and lets their id be claimed again', async () => {
    const store = cdsSettlementStore();
    await store.claim(OTHER, Date.now() - 1_000, later());
    expect(await rows()).toHaveLength(1);

    await store.claim(TX, later(), later());
    expect((await rows()).map(r => r.txId)).toEqual([TX]);

    await run(cds.ql.UPDATE.entity(DEFAULT_SETTLEMENTS_ENTITY)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString(), state: 'settled' }).where({ txId: TX }));
    expect(await store.claim(TX, later(), later())).toEqual({ claimed: true });
    expect((await store.get(TX))?.state).toBe('submitting');
  });
});

describe('cdsSettlementStore, get', () => {
  it('is undefined for an unknown id and hides an expired row', async () => {
    const store = cdsSettlementStore();
    expect(await store.get(TX)).toBeUndefined();
    await store.claim(TX, Date.now() - 1_000, later());
    expect(await rows()).toHaveLength(1);
    expect(await store.get(TX)).toBeUndefined();
  });
});

describe('cdsSettlementStore, resume', () => {
  it('takes over a pending row once and writes the new lease', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    await store.update(TX, { state: 'pending', broadcast: true });
    const leaseUntil = Date.now() + 9_000;
    expect(await store.resume(TX, leaseUntil)).toBe(true);
    expect(await store.resume(TX, leaseUntil)).toBe(false);
    expect(await store.get(TX)).toMatchObject({ state: 'submitting', leaseUntil, broadcast: true });
  });

  it('gives a pending row to only one of two concurrent retries', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    await store.update(TX, { state: 'pending' });
    const [a, b] = await Promise.all([store.resume(TX, later()), store.resume(TX, later())]);
    expect([a, b].sort()).toEqual([false, true]);
  });

  it('leaves a submitting row alone while its lease runs', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    expect(await store.resume(TX, later())).toBe(false);
  });

  it('takes over a submitting row whose lease ran out', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), Date.now() - 1_000);
    const leaseUntil = later();
    expect(await store.resume(TX, leaseUntil)).toBe(true);
    expect(await store.resume(TX, later())).toBe(false);
    expect(await store.get(TX)).toMatchObject({ state: 'submitting', leaseUntil });
  });

  it.each(['settled', 'failed'] as const)('never resumes a %s row', async (state) => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), Date.now() - 1_000);
    await store.update(TX, { state });
    expect(await store.resume(TX, later())).toBe(false);
    expect((await store.get(TX))?.state).toBe(state);
  });

  it('does not resume an unknown id', async () => {
    expect(await cdsSettlementStore().resume(TX, later())).toBe(false);
  });
});

describe('cdsSettlementStore, update and release', () => {
  it('writes state, broadcast, lease, expiry and the response as JSON, and reads them back', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    const response = { success: true, transaction: TX, network: 'cardano:preview', payer: 'addr_test1x', amount: '2000000' };
    const expiresAt = Date.now() + 120_000;
    const leaseUntil = Date.now() + 30_000;
    await store.update(TX, { state: 'settled', broadcast: true, expiresAt, leaseUntil, response });

    const [row] = await rows();
    expect(row!.state).toBe('settled');
    expect(JSON.parse(row!.response!)).toEqual(response);
    expect(await store.get(TX)).toEqual({ txId: TX, state: 'settled', expiresAt, leaseUntil, broadcast: true, response });
  });

  it('changes only the fields of the patch', async () => {
    const store = cdsSettlementStore();
    const expiresAt = later();
    await store.claim(TX, expiresAt, later());
    await store.update(TX, { broadcast: true });
    expect(await store.get(TX)).toMatchObject({ state: 'submitting', expiresAt, broadcast: true });
  });

  it('ignores an unreadable response column', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    await run(cds.ql.UPDATE.entity(DEFAULT_SETTLEMENTS_ENTITY).set({ response: '{not json' }).where({ txId: TX }));
    const record = await store.get(TX);
    expect(record?.state).toBe('submitting');
    expect(record).not.toHaveProperty('response');
  });

  it('releases a claim', async () => {
    const store = cdsSettlementStore();
    await store.claim(TX, later(), later());
    await store.release(TX);
    expect(await rows()).toEqual([]);
    expect(await store.claim(TX, later(), later())).toEqual({ claimed: true });
  });
});

describe('cdsSettlementStore, entity', () => {
  it('rejects when the entity does not exist', async () => {
    // The driver's error objects belong to another jest realm, so match the message, not the class.
    await expect(cdsSettlementStore('no.such.Entity').claim(TX, later(), later()))
      .rejects.toMatchObject({ message: expect.stringContaining('no such table') });
  });
});
