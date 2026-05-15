/**
 * End-to-end orchestrator test with a fully-mocked bridge.
 *
 * Each test drives one rejection branch + the happy path, so we know
 * the pipeline orders checks correctly:
 *   missing header → decode → validate → nonce → settle → onAccepted.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { process as verifyPayment } from '../../srv/facilitator/verify';
import { buildPaymentRequirements } from '../../srv/core/requirements';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, FUTURE_SLOT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx } from '../fixtures/build-tx';
import { buildEnvelope } from '../fixtures/envelope';

const mockedBridge = jest.mocked(bridge);

function happyEnvelope({
  amount = '1000000',
  outputAddr = SELLER_ADDR,
}: { amount?: string; outputAddr?: string } = {}) {
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: [{ address: outputAddr, lovelace: amount }],
    ttlSlot: FUTURE_SLOT,
  });
  const signed = signTx(body, [BUYER_PRIV]);
  return buildEnvelope({ txCborHex: signed.cborHex, nonceRef: NONCE_REF });
}

const requirementsBody = () => buildPaymentRequirements({
  amount: '1000000',
  asset: 'lovelace',
  payTo: SELLER_ADDR,
  network: NETWORK_PREPROD,
  resource: '/r',
});

beforeEach(() => {
  jest.resetAllMocks();
  // Sensible defaults; individual tests override.
  mockedBridge.getCurrentSlot.mockResolvedValue(CURRENT_SLOT);
  mockedBridge.isUtxoUnspent.mockResolvedValue(true);
  mockedBridge.submitTransaction.mockResolvedValue('');
  mockedBridge.getTransactionByHash.mockResolvedValue({} as unknown);
});

describe('verifyPayment, happy path', () => {
  it('returns accepted + invokes onAccepted callback', async () => {
    const onAccepted = jest.fn();
    const envelope = happyEnvelope();

    // submit returns the locally-computed hash (round-trips through settle)
    mockedBridge.submitTransaction.mockImplementation(async (cborHex) => {
      // emulate the network echoing the same hash back
      const { decode } = await import('../../srv/core/decode');
      const decoded = decode(envelope);
      expect(cborHex).toBe(decoded.txCborHex);
      return decoded.txHash;
    });
    mockedBridge.getTransactionByHash.mockResolvedValue({ hash: 'ok' } as unknown);

    const r = await verifyPayment({
      paymentHeader: envelope,
      requirementsBody: requirementsBody(),
      onAccepted,
    });

    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.payment.network).toBe(NETWORK_PREPROD);
      expect(r.payment.amountUnits).toBe('1000000');
      expect(r.paymentResponseB64).toBeTruthy();
      // base64 of {success:true, network, transaction:txHash}
      const decoded = JSON.parse(Buffer.from(r.paymentResponseB64, 'base64').toString('utf8'));
      expect(decoded).toMatchObject({ success: true, network: NETWORK_PREPROD });
    }
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });
});

describe('verifyPayment, rejection branches', () => {
  it('MISSING_HEADER when paymentHeader is undefined', async () => {
    const r = await verifyPayment({
      paymentHeader: undefined,
      requirementsBody: requirementsBody(),
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.code).toBe(Codes.MISSING_HEADER);
    expect(mockedBridge.getCurrentSlot).not.toHaveBeenCalled();
  });

  it('decode-level errors propagate with their codes', async () => {
    const r = await verifyPayment({
      paymentHeader: 'not-base64-!!!',
      requirementsBody: requirementsBody(),
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.code).toBe(Codes.INVALID_BASE64);
  });

  it('validate-level WRONG_RECIPIENT propagates', async () => {
    // Build an envelope where the output goes to the buyer (not the seller).
    const { BUYER_ADDR } = await import('../fixtures/constants');
    const wrongRecipient = buildEnvelope({
      txCborHex: signTx(buildBody({
        inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
        outputs: [{ address: BUYER_ADDR, lovelace: '1000000' }],
        ttlSlot: FUTURE_SLOT,
      }), [BUYER_PRIV]).cborHex,
      nonceRef: NONCE_REF,
    });

    const r = await verifyPayment({
      paymentHeader: wrongRecipient,
      requirementsBody: requirementsBody(),
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.code).toBe(Codes.WRONG_RECIPIENT);
  });

  it('REPLAY when bridge reports the nonce UTxO is spent', async () => {
    mockedBridge.isUtxoUnspent.mockResolvedValue(false);
    const r = await verifyPayment({
      paymentHeader: happyEnvelope(),
      requirementsBody: requirementsBody(),
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.code).toBe(Codes.REPLAY);
    // settle must not have been called
    expect(mockedBridge.submitTransaction).not.toHaveBeenCalled();
  });

  it('BRIDGE_UNAVAILABLE when getCurrentSlot fails', async () => {
    mockedBridge.getCurrentSlot.mockRejectedValue(new Error('bridge down'));
    const r = await verifyPayment({
      paymentHeader: happyEnvelope(),
      requirementsBody: requirementsBody(),
    });
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') {
      expect(r.code).toBe(Codes.BRIDGE_UNAVAILABLE);
      expect(r.reason).toMatch(/bridge down/);
    }
  });
});

describe('verifyPayment, pending', () => {
  it('returns pending when settle times out', async () => {
    const envelope = happyEnvelope();
    const { decode } = await import('../../srv/core/decode');
    const decoded = decode(envelope);

    mockedBridge.submitTransaction.mockResolvedValue(decoded.txHash);
    mockedBridge.getTransactionByHash.mockResolvedValue(null); // never visible

    const r = await verifyPayment({
      paymentHeader: envelope,
      requirementsBody: requirementsBody(),
      settlePollBudgetMs: 100,
    });
    expect(r.kind).toBe('pending');
    if (r.kind === 'pending') {
      expect(r.code).toBe(Codes.PENDING);
      expect(r.txHash).toBe(decoded.txHash);
    }
  });
});

describe('verifyPayment, onAccepted is best-effort', () => {
  it('still returns accepted when onAccepted throws', async () => {
    const envelope = happyEnvelope();
    const { decode } = await import('../../srv/core/decode');
    const decoded = decode(envelope);

    mockedBridge.submitTransaction.mockResolvedValue(decoded.txHash);
    mockedBridge.getTransactionByHash.mockResolvedValue({ hash: 'ok' } as unknown);

    const onAccepted = jest.fn().mockRejectedValue(new Error('audit DB down'));
    const r = await verifyPayment({
      paymentHeader: envelope,
      requirementsBody: requirementsBody(),
      onAccepted,
    });
    expect(r.kind).toBe('accepted');
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });
});
