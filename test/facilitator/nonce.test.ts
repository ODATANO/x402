/**
 * Tests for the chain-touching part of replay-defense check #5.
 * Bridge is mocked at the module level, these tests assert that the
 * facilitator interprets bridge results correctly, not that the bridge
 * itself works (that's an integration concern).
 *
 * As of @odatano/core@1.7.8, `isUtxoUnspent` is a first-class method
 * on the Cardano client: spent and nonexistent both surface as `false`,
 * and the facilitator collapses them into a single REPLAY rejection.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { checkNonceUnspent } from '../../srv/facilitator/nonce';
import { Codes } from '../../srv/core/errors';

const mockedBridge = jest.mocked(bridge);

beforeEach(() => {
  jest.resetAllMocks();
});

describe('checkNonceUnspent', () => {
  it('returns ok when the bridge reports unspent', async () => {
    mockedBridge.isUtxoUnspent.mockResolvedValue(true);
    const r = await checkNonceUnspent({
      txHash: 'ab'.repeat(32),
      outputIndex: 0,
    });
    expect(r.ok).toBe(true);
    expect(mockedBridge.isUtxoUnspent).toHaveBeenCalledWith('ab'.repeat(32), 0);
  });

  it('returns REPLAY when the bridge reports spent', async () => {
    mockedBridge.isUtxoUnspent.mockResolvedValue(false);
    const r = await checkNonceUnspent({
      txHash: 'ab'.repeat(32),
      outputIndex: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(Codes.REPLAY);
      expect(r.reason).toMatch(/spent or does not exist/);
    }
  });

  it('also surfaces nonexistent UTxOs as REPLAY (bridge returns false)', async () => {
    // Per @odatano/core 1.7.8 contract: tx not on chain → false (not throw).
    mockedBridge.isUtxoUnspent.mockResolvedValue(false);
    const r = await checkNonceUnspent({
      txHash: 'cd'.repeat(32),
      outputIndex: 99,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.REPLAY);
  });

  it('propagates unexpected bridge errors (5xx, network)', async () => {
    mockedBridge.isUtxoUnspent.mockRejectedValue(new Error('backend 503'));
    await expect(checkNonceUnspent({ txHash: 'ab'.repeat(32), outputIndex: 0 }))
      .rejects.toThrow(/backend 503/);
  });
});
