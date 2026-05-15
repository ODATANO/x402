/**
 * Tests for submit + poll-until-confirmed. The bridge is mocked so we
 * can drive each branch (success, idempotent-already-known, real
 * submit-failure, timeout-pending) deterministically.
 *
 * Real `setTimeout` is fine, tests use short poll budgets (≤ 200 ms).
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { settle } from '../../srv/facilitator/settle';
import { Codes } from '../../srv/core/errors';

const mockedBridge = jest.mocked(bridge);
const TX_HASH = 'ee'.repeat(32);
const TX_CBOR = '84a0...';

beforeEach(() => {
  jest.resetAllMocks();
});

describe('settle, happy path', () => {
  it('returns confirmed when submit succeeds and tx is immediately visible', async () => {
    mockedBridge.submitTransaction.mockResolvedValue(TX_HASH);
    mockedBridge.getTransactionByHash.mockResolvedValue({ hash: TX_HASH } as unknown);

    const r = await settle({ signedTxCborHex: TX_CBOR, expectedTxHash: TX_HASH });
    expect(r.confirmed).toBe(true);
    expect(r.txHash).toBe(TX_HASH);
  });

  it('returns confirmed when tx becomes visible after one poll', async () => {
    mockedBridge.submitTransaction.mockResolvedValue(TX_HASH);
    mockedBridge.getTransactionByHash
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ hash: TX_HASH } as unknown);

    const r = await settle({
      signedTxCborHex: TX_CBOR,
      expectedTxHash: TX_HASH,
      pollBudgetMs: 200,
      pollIntervalMs: 50,
    });
    expect(r.confirmed).toBe(true);
  });
});

describe('settle, idempotency on "already known"', () => {
  it('falls through to polling when submit says tx is in mempool', async () => {
    mockedBridge.submitTransaction.mockRejectedValue(
      new Error('Transaction is already in the mempool'),
    );
    mockedBridge.getTransactionByHash.mockResolvedValue({ hash: TX_HASH } as unknown);
    const r = await settle({ signedTxCborHex: TX_CBOR, expectedTxHash: TX_HASH });
    expect(r.confirmed).toBe(true);
  });

  it('treats BadInputsUTxO (already-spent) as "tx is on chain"', async () => {
    mockedBridge.submitTransaction.mockRejectedValue(
      new Error('BadInputsUTxO: all inputs are spent'),
    );
    mockedBridge.getTransactionByHash.mockResolvedValue({ hash: TX_HASH } as unknown);
    const r = await settle({ signedTxCborHex: TX_CBOR, expectedTxHash: TX_HASH });
    expect(r.confirmed).toBe(true);
  });
});

describe('settle, real failures', () => {
  it('returns SUBMIT_FAILED on a non-recoverable submit error', async () => {
    mockedBridge.submitTransaction.mockRejectedValue(
      new Error('OutsideValidityIntervalUTxO'),
    );
    const r = await settle({ signedTxCborHex: TX_CBOR, expectedTxHash: TX_HASH });
    expect(r.confirmed).toBe(false);
    expect(r.code).toBe(Codes.SUBMIT_FAILED);
    expect(r.reason).toMatch(/OutsideValidityIntervalUTxO/);
  });

  it('returns SUBMIT_FAILED when submit returns a mismatched hash', async () => {
    mockedBridge.submitTransaction.mockResolvedValue('ff'.repeat(32));
    const r = await settle({ signedTxCborHex: TX_CBOR, expectedTxHash: TX_HASH });
    expect(r.confirmed).toBe(false);
    expect(r.code).toBe(Codes.SUBMIT_FAILED);
    expect(r.reason).toMatch(/submit returned hash/);
  });
});

describe('settle, pending on timeout', () => {
  it('returns pending when polling budget expires', async () => {
    mockedBridge.submitTransaction.mockResolvedValue(TX_HASH);
    mockedBridge.getTransactionByHash.mockResolvedValue(null); // never visible

    const r = await settle({
      signedTxCborHex: TX_CBOR,
      expectedTxHash: TX_HASH,
      pollBudgetMs: 100,
      pollIntervalMs: 25,
    });
    expect(r.confirmed).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.code).toBe(Codes.PENDING);
    expect(r.txHash).toBe(TX_HASH);
  });
});

describe('settle, validation', () => {
  it('throws on missing signedTxCborHex', async () => {
    await expect(settle({ signedTxCborHex: '', expectedTxHash: TX_HASH }))
      .rejects.toThrow(/signedTxCborHex/);
  });
  it('throws on missing expectedTxHash', async () => {
    await expect(settle({ signedTxCborHex: TX_CBOR, expectedTxHash: '' }))
      .rejects.toThrow(/expectedTxHash/);
  });
});
