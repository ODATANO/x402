/**
 * Tests for the CAP-backed receipts module. Exercises the option-shape
 * resolver and the INSERT success / failure paths. INSERT failures are
 * SWALLOWED by design (canonical record is on chain), so we assert the
 * promise resolves rather than rejects.
 */

import '@sap/cds'; // ensure INSERT global exists before override
import {
  DEFAULT_RECEIPTS_ENTITY,
  resolveReceiptsEntity,
  persistReceipt,
} from '../../srv/middleware/receipts';
import type { PaymentClaim } from '../../srv/core/types';

const claim: PaymentClaim = {
  txHash:      'ab'.repeat(32),
  payerAddr:   'addr_test1qpayer',
  payTo:       'addr_test1qseller',
  asset:       'lovelace',
  amountUnits: '1000000',
  network:     'cardano:preprod',
  nonceRef:    'ab'.repeat(32) + '#0',
};

const insertDesc = Object.getOwnPropertyDescriptor(globalThis, 'INSERT');
function setINSERT(impl: unknown) {
  Object.defineProperty(globalThis, 'INSERT', { value: impl, configurable: true, writable: true });
}
afterEach(() => {
  if (insertDesc) Object.defineProperty(globalThis, 'INSERT', insertDesc);
});

describe('resolveReceiptsEntity', () => {
  it('returns null when receipts is falsy', () => {
    expect(resolveReceiptsEntity(undefined)).toBeNull();
    expect(resolveReceiptsEntity(false)).toBeNull();
  });

  it('returns the default entity when receipts is true', () => {
    expect(resolveReceiptsEntity(true)).toBe(DEFAULT_RECEIPTS_ENTITY);
  });

  it('returns a custom entity when provided', () => {
    expect(resolveReceiptsEntity({ entity: 'my.ns.MyReceipts' })).toBe('my.ns.MyReceipts');
  });

  it('falls back to the default when entity is omitted', () => {
    expect(resolveReceiptsEntity({})).toBe(DEFAULT_RECEIPTS_ENTITY);
  });
});

describe('persistReceipt', () => {
  it('inserts a row with the full claim shape', async () => {
    const entries = jest.fn().mockResolvedValue(undefined);
    const into    = jest.fn(() => ({ entries }));
    setINSERT({ into });

    await persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim, '/api/foo');
    expect(into).toHaveBeenCalledWith(DEFAULT_RECEIPTS_ENTITY);
    const row = entries.mock.calls[0][0];
    expect(row).toMatchObject({
      txHash:    claim.txHash,
      payerAddr: claim.payerAddr,
      payTo:     claim.payTo,
      asset:     claim.asset,
      amount:    claim.amountUnits,
      network:   claim.network,
      route:     '/api/foo',
      nonceRef:  claim.nonceRef,
    });
    expect(typeof row.ID).toBe('string');
    expect(new Date(row.at).toString()).not.toBe('Invalid Date');
  });

  it('writes payerAddr=null when the claim has none', async () => {
    const entries = jest.fn().mockResolvedValue(undefined);
    setINSERT({ into: () => ({ entries }) });

    const noPayer: PaymentClaim = { ...claim, payerAddr: undefined };
    await persistReceipt(DEFAULT_RECEIPTS_ENTITY, noPayer, '/api/foo');
    expect(entries.mock.calls[0][0].payerAddr).toBeNull();
  });

  it('swallows INSERT failure (canonical record is on chain)', async () => {
    setINSERT({ into: () => ({ entries: () => Promise.reject(new Error('db down')) }) });
    await expect(persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim, '/api/foo'))
      .resolves.toBeUndefined();
  });

  it('handles non-Error rejection objects without crashing', async () => {
    setINSERT({ into: () => ({ entries: () => Promise.reject('plain string') }) });
    await expect(persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim, '/api/foo'))
      .resolves.toBeUndefined();
  });
});
