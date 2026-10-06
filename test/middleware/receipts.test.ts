/**
 * Receipts against a real in-memory sqlite: the row, its columns and the
 * transaction it is written in.
 */

import cds from '@sap/cds';
import { persistReceipt, DEFAULT_RECEIPTS_ENTITY } from '../../srv/middleware/receipts';
import { deployTestDb, closeTestDb, rowsOf } from '../fixtures/db';
import { BUYER_ADDR, SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';
import type { PaymentClaim } from '../../srv/core/types';

const ROUTE = '/odata/v4/prices/Quotes';

function claim(txHash: string, payerAddr: string | undefined = BUYER_ADDR): PaymentClaim {
  return {
    txHash,
    amountUnits: '1000000',
    network:     NETWORK_PREPROD,
    unit:        '',
    asset:       'lovelace',
    payTo:       SELLER_ADDR,
    resourceUrl: ROUTE,
    nonceRef:    `${'dd'.repeat(32)}#0`,
    ...(payerAddr ? { payerAddr } : {}),
  };
}

const receiptOf = async (txHash: string) =>
  (await rowsOf<Record<string, unknown>>(DEFAULT_RECEIPTS_ENTITY)).find(r => r.txHash === txHash);

let warn: jest.SpyInstance;

beforeAll(deployTestDb);
afterAll(closeTestDb);
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

describe('persistReceipt', () => {
  it('writes one row with every column of the claim', async () => {
    const tx = 'a1'.repeat(32);
    await persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim(tx), ROUTE);
    const row = await receiptOf(tx);
    expect(row).toMatchObject({
      txHash:    tx,
      payerAddr: BUYER_ADDR,
      payTo:     SELLER_ADDR,
      asset:     'lovelace',
      amount:    '1000000',
      network:   NETWORK_PREPROD,
      route:     ROUTE,
      nonceRef:  `${'dd'.repeat(32)}#0`,
    });
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(String(row!.at)))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes payerAddr null when the claim has none', async () => {
    const tx = 'a2'.repeat(32);
    await persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim(tx, ''), ROUTE);
    expect((await receiptOf(tx))!.payerAddr).toBeNull();
  });

  it('commits on its own, so the row survives a failing outer transaction', async () => {
    const tx = 'a3'.repeat(32);
    await expect(cds.tx(async () => {
      await persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim(tx), ROUTE);
      throw new Error('request failed');
    })).rejects.toThrow('request failed');
    expect(await receiptOf(tx)).toBeDefined();
  });

  it('keeps one row per txHash; a second insert is logged, not thrown', async () => {
    const tx = 'a4'.repeat(32);
    await persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim(tx), ROUTE);
    await expect(persistReceipt(DEFAULT_RECEIPTS_ENTITY, claim(tx), ROUTE)).resolves.toBeUndefined();
    const rows = (await rowsOf<Record<string, unknown>>(DEFAULT_RECEIPTS_ENTITY)).filter(r => r.txHash === tx);
    expect(rows).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs an insert into a missing entity instead of throwing', async () => {
    await expect(persistReceipt('no.such.Entity', claim('a5'.repeat(32)), ROUTE)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain('no.such.Entity');
  });
});
