/**
 * Tests for the post-paid / subscription verifier. Bridge is mocked.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { verifyConfirmedPayment } from '../../srv/helpers/verify-confirmed';
import { Codes } from '../../srv/core/errors';
import {
  SELLER_ADDR, BUYER_ADDR,
  TEST_POLICY_ID, TEST_ASSET_NAME, TEST_ASSET_STRING, TEST_ASSET_UNIT,
  USDM_PREPROD_ASSET,
  NETWORK_PREPROD,
} from '../fixtures/constants';

const mockedBridge = jest.mocked(bridge);

const VALID_TX = 'ab'.repeat(32);

beforeEach(() => {
  jest.resetAllMocks();
});

describe('verifyConfirmedPayment, input validation', () => {
  it('rejects malformed txHash', async () => {
    const r = await verifyConfirmedPayment({
      txHash: 'short',
      requiredAmount: '1',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INVALID_CBOR);
  });

  it('rejects non-hex txHash', async () => {
    const r = await verifyConfirmedPayment({
      txHash: 'zz'.repeat(32),
      requiredAmount: '1',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects v1 network format', async () => {
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: 'cardano-preprod',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INVALID_NETWORK_FORMAT);
  });

  it('rejects malformed asset', async () => {
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1',
      asset: 'not-a-real-asset',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INVALID_ASSET_FORMAT);
  });
});

describe('verifyConfirmedPayment, chain interactions', () => {
  it('returns PENDING when tx is not yet on chain', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(null);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(Codes.PENDING);
      expect(r.reason).toMatch(/not found on-chain/);
    }
  });

  it('returns PENDING when the bridge throws (treated as transient)', async () => {
    mockedBridge.getTransactionByHash.mockRejectedValue(new Error('bridge timeout'));
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(Codes.PENDING);
      expect(r.reason).toMatch(/bridge timeout/);
    }
  });

  it('returns WRONG_ASSET when payTo receives nothing of the asset', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1',
      asset: USDM_PREPROD_ASSET,
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.WRONG_ASSET);
  });

  it('returns INSUFFICIENT_AMOUNT when paid < required', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [{ address: SELLER_ADDR, lovelace: '500000' }],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1000000',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INSUFFICIENT_AMOUNT);
  });

  it('accepts when payTo receives ≥ required lovelace', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [{ address: SELLER_ADDR, lovelace: '2000000' }],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1000000',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amountUnits).toBe('2000000');
  });

  it('accepts when payTo receives ≥ required native-asset units (summed)', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [
        { address: BUYER_ADDR,  lovelace: '500000' },
        { address: SELLER_ADDR, lovelace: '1500000', assets: [{ unit: TEST_ASSET_UNIT, quantity: '7' }] },
        { address: SELLER_ADDR, lovelace: '0',       assets: [{ unit: TEST_ASSET_UNIT, quantity: '3' }] },
      ],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '10',
      asset: TEST_ASSET_STRING,
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amountUnits).toBe('10');
  });

  it('ignores outputs to other addresses', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [
        { address: BUYER_ADDR, lovelace: '100000000' }, // a giant payment elsewhere
        { address: SELLER_ADDR, lovelace: '500000' },
      ],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX,
      requiredAmount: '1000000',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.INSUFFICIENT_AMOUNT);
  });
});

describe('verifyConfirmedPayment, defensive defaults', () => {
  it('handles a tx with no outputs array (paid=0 → WRONG_ASSET)', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({} as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX, requiredAmount: '1', asset: 'lovelace',
      payTo: SELLER_ADDR, network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(Codes.WRONG_ASSET);
  });

  it('handles lovelace outputs with missing lovelace field (defaults to 0)', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [
        { address: SELLER_ADDR },                         // no lovelace
        { address: SELLER_ADDR, lovelace: '500000' },     // contributes 500k
      ],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX, requiredAmount: '500000', asset: 'lovelace',
      payTo: SELLER_ADDR, network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(true);
  });

  it('handles asset entries with matching unit but no quantity field (defaults to 0)', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue({
      outputs: [{
        address: SELLER_ADDR, lovelace: '1500000',
        assets: [
          { unit: TEST_ASSET_UNIT },                          // matches, no qty → 0
          { unit: TEST_ASSET_UNIT, quantity: '10' },          // contributes 10
        ],
      }],
    } as unknown);
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX, requiredAmount: '10', asset: TEST_ASSET_STRING,
      payTo: SELLER_ADDR, network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(true);
  });

  it('treats non-Error bridge rejections as PENDING', async () => {
    mockedBridge.getTransactionByHash.mockRejectedValue('plain string');
    const r = await verifyConfirmedPayment({
      txHash: VALID_TX, requiredAmount: '1', asset: 'lovelace',
      payTo: SELLER_ADDR, network: NETWORK_PREPROD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(Codes.PENDING);
      expect(r.reason).toContain('plain string');
    }
  });
});

// touch unused import to keep noUnusedLocals happy
void TEST_POLICY_ID;
void TEST_ASSET_NAME;
