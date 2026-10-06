/** In-process settlement claims (memorySettlementStore). */

import { memorySettlementStore, isResumable, type SettlementRecord } from '../../srv/facilitator/store';

const TX = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const later = () => Date.now() + 60_000;

describe('memorySettlementStore', () => {
  it('gives the claim to exactly one of two concurrent callers', async () => {
    const store = memorySettlementStore();
    const [a, b] = await Promise.all([store.claim(TX, later(), later()), store.claim(TX, later(), later())]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    const loser = a.claimed ? b : a;
    if (!loser.claimed) expect(loser.record).toMatchObject({ txId: TX, state: 'submitting' });
  });

  it('starts a claim as submitting with its lease and no broadcast', async () => {
    const store = memorySettlementStore();
    const expiresAt = later();
    const leaseUntil = Date.now() + 5_000;
    await store.claim(TX, expiresAt, leaseUntil);
    expect(await store.get(TX)).toEqual({ txId: TX, state: 'submitting', expiresAt, leaseUntil, broadcast: false });
  });

  it('updates and reads a record', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), later());
    const response = { success: true, transaction: TX, network: 'cardano:preview' };
    await store.update(TX, { state: 'settled', broadcast: true, response });
    expect(await store.get(TX)).toMatchObject({ state: 'settled', broadcast: true, response });
  });

  it('returns copies, so callers cannot mutate stored records', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), later());
    const r = await store.get(TX);
    r!.state = 'failed';
    expect((await store.get(TX))?.state).toBe('submitting');
  });

  it('drops expired records and lets the claim be taken again', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, Date.now() - 1, later());
    expect(await store.get(TX)).toBeUndefined();
    expect((await store.claim(TX, later(), later())).claimed).toBe(true);
  });

  it('sweeps other expired records when a claim is taken', async () => {
    const store = memorySettlementStore();
    await store.claim(OTHER, Date.now() - 1, later());
    await store.claim(TX, later(), later());
    expect(await store.get(OTHER)).toBeUndefined();
    expect((await store.get(TX))?.state).toBe('submitting');
  });

  it('releases a claim', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), later());
    await store.release(TX);
    expect(await store.get(TX)).toBeUndefined();
    expect((await store.claim(TX, later(), later())).claimed).toBe(true);
  });

  it('ignores updates for unknown ids', async () => {
    const store = memorySettlementStore();
    await store.update(TX, { state: 'settled' });
    expect(await store.get(TX)).toBeUndefined();
  });
});

describe('memorySettlementStore, resume', () => {
  it('does not resume an unknown id', async () => {
    expect(await memorySettlementStore().resume(TX, later())).toBe(false);
  });

  it('takes over a pending record once and sets the new lease', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), later());
    await store.update(TX, { state: 'pending', broadcast: true });
    const leaseUntil = Date.now() + 9_000;
    const [a, b] = await Promise.all([store.resume(TX, leaseUntil), store.resume(TX, leaseUntil)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await store.get(TX)).toMatchObject({ state: 'submitting', leaseUntil, broadcast: true });
  });

  it('leaves a submitting record alone while its lease runs', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), later());
    expect(await store.resume(TX, later())).toBe(false);
  });

  it('takes over a submitting record whose lease ran out, once', async () => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), Date.now() - 1);
    const [a, b] = await Promise.all([store.resume(TX, later()), store.resume(TX, later())]);
    expect([a, b].sort()).toEqual([false, true]);
    expect((await store.get(TX))?.state).toBe('submitting');
  });

  it.each(['settled', 'failed'] as const)('never resumes a %s record', async (state) => {
    const store = memorySettlementStore();
    await store.claim(TX, later(), Date.now() - 1);
    await store.update(TX, { state });
    expect(await store.resume(TX, later())).toBe(false);
    expect((await store.get(TX))?.state).toBe(state);
  });
});

describe('isResumable', () => {
  const record = (over: Partial<SettlementRecord>): SettlementRecord =>
    ({ txId: TX, state: 'submitting', expiresAt: later(), broadcast: false, ...over });

  it('is true for pending, and for submitting once the lease ran out or is missing', () => {
    expect(isResumable(record({ state: 'pending' }))).toBe(true);
    expect(isResumable(record({ leaseUntil: Date.now() - 1 }))).toBe(true);
    expect(isResumable(record({}))).toBe(true);
    expect(isResumable(record({ leaseUntil: 1_000 }), 999)).toBe(false);
    expect(isResumable(record({ leaseUntil: 1_000 }), 1_000)).toBe(true);
  });

  it('is false for a live lease and for settled or failed records', () => {
    expect(isResumable(record({ leaseUntil: later() }))).toBe(false);
    expect(isResumable(record({ state: 'settled' }))).toBe(false);
    expect(isResumable(record({ state: 'failed' }))).toBe(false);
  });
});
