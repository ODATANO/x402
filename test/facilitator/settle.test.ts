/**
 * Facilitator `/settle` (runSettle): claim and lease, submit outcomes,
 * confirmation policy, pending and resume, duplicates, expiry.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { runSettle, type SettleContext } from '../../srv/facilitator/settle';
import { memorySettlementStore, type SettlementStore } from '../../srv/facilitator/store';
import { buildRequirements } from '../../srv/core/requirements';
import { parsePaymentPayload } from '../../srv/core/payload';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, TTL_SLOT, MAX_TTL_SLOT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx } from '../fixtures/build-tx';
import { buildPaymentSignature } from '../fixtures/envelope';
import { realParseTransaction, buyerSignedWitnesses } from '../fixtures/core-parse-mock';
import type { ChainTx, SubmitOutcome } from '../../srv/bridge';
import type { PaymentPayload, PaymentRequirements } from '../../srv/core/types';

const mocked = jest.mocked(bridge);
const FUNDING = 10_000_000n;
const PRICE = 2_000_000n;
const FEE = 200_000n;
const TX_HEIGHT = 100;

function requirements(l1Confirmations?: number): PaymentRequirements {
  return buildRequirements({
    amount: PRICE, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD,
    ...(l1Confirmations !== undefined ? { confirmationPolicy: { l1Confirmations } } : {}),
  });
}

function payment(req: PaymentRequirements): { payload: PaymentPayload; txHash: string } {
  const signed = signTx(buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: [
      { address: SELLER_ADDR, lovelace: PRICE.toString() },
      { address: BUYER_ADDR, lovelace: (FUNDING - PRICE - FEE).toString() },
    ],
    fee: FEE.toString(),
    ttlSlot: TTL_SLOT,
  }), [BUYER_PRIV]);
  const header = buildPaymentSignature({ accepted: req, txCborHex: signed.cborHex, nonceRef: NONCE_REF });
  return { payload: parsePaymentPayload(header), txHash: signed.txHash };
}

function ctx(over: Partial<SettleContext> = {}): SettleContext {
  return {
    store: memorySettlementStore(),
    allowMempoolConfirmation: false,
    pollBudgetMs: 40,
    pollIntervalMs: 5,
    claimGraceMs: 60_000,
    ...over,
  };
}

/** Whether the payment tx is on chain; flip it during a test. */
let landed = false;
/** Set to make the landed payment tx a failed script run. */
let scriptFailed = false;

const accepted: SubmitOutcome = { kind: 'accepted' };
const unknown: SubmitOutcome = { kind: 'unknown', reason: 'socket hang up' };
const rejected: SubmitOutcome = { kind: 'rejected', reason: 'FeeTooSmallUTxO' };

/** Submit answers `outcome` and the tx never shows up on chain. */
function submitWithoutLanding(outcome: SubmitOutcome): void {
  mocked.trySubmit.mockResolvedValue(outcome);
}

beforeEach(() => {
  jest.resetAllMocks();
  landed = false;
  scriptFailed = false;
  mocked.parseTransaction.mockImplementation(realParseTransaction as typeof bridge.parseTransaction);
  mocked.verifyTxWitnesses.mockReturnValue(buyerSignedWitnesses());
  mocked.createdOutputs.mockImplementation(tx => tx.outputs.filter(o => Boolean(o.isCollateral) === (tx.spendsCollaterals === true)));
  mocked.getCurrentSlot.mockResolvedValue(CURRENT_SLOT);
  mocked.posixToSlot.mockReturnValue(MAX_TTL_SLOT);
  mocked.slotToPosixMs.mockReturnValue(Date.now() + 300_000);
  mocked.isUtxoUnspent.mockResolvedValue(true);
  mocked.getFeeParameters.mockResolvedValue({ minFeeA: 44n, minFeeB: 155_381n, coinsPerUtxoByte: 4_310n });
  mocked.getTipHeight.mockResolvedValue(TX_HEIGHT + 1);
  mocked.trySubmit.mockImplementation(async () => { landed = true; return accepted; });
  mocked.getTransactionByHash.mockImplementation(async (hash: string): Promise<ChainTx | null> => {
    if (hash === NONCE_TX_HASH) {
      return {
        hash, blockHeight: 90, blockTime: 1,
        outputs: [{ address: BUYER_ADDR, amount: [{ unit: 'lovelace', quantity: FUNDING.toString() }], outputIndex: NONCE_INDEX }],
      };
    }
    if (!landed) return null;
    return { hash, blockHeight: TX_HEIGHT, blockTime: 2, outputs: [], ...(scriptFailed ? { spendsCollaterals: true } : {}) };
  });
});

describe('runSettle, confirmation policy', () => {
  it('settles once the default one confirmation is reached', async () => {
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const r = await runSettle(payload, req, c);
    expect(r).toEqual({
      success: true,
      transaction: txHash,
      network: NETWORK_PREPROD,
      payer: BUYER_ADDR,
      amount: PRICE.toString(),
      extra: { status: 'confirmed', confirmations: 1, transactionId: txHash },
    });
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
    expect(await c.store.get(txHash)).toMatchObject({ state: 'settled', broadcast: true, response: r });
  });

  it('settles at inclusion for policy 0', async () => {
    const req = requirements(0);
    const { payload } = payment(req);
    mocked.getTipHeight.mockResolvedValue(TX_HEIGHT);
    const r = await runSettle(payload, req, ctx());
    expect(r.success).toBe(true);
    expect(r.extra).toMatchObject({ status: 'confirmed', confirmations: 0 });
  });

  it('answers pending while the block depth is below the policy', async () => {
    const req = requirements(3);
    const { payload } = payment(req);
    const r = await runSettle(payload, req, ctx());
    expect(r).toMatchObject({ success: false, errorReason: Codes.PENDING, extra: { status: 'pending', confirmations: 1 } });
  });

  it('settles on broadcast for policy -1 once a backend took the tx', async () => {
    submitWithoutLanding(accepted);
    const req = requirements(-1);
    const { payload, txHash } = payment(req);
    const r = await runSettle(payload, req, ctx({ allowMempoolConfirmation: true }));
    expect(r).toMatchObject({ success: true, transaction: txHash, extra: { status: 'mempool', confirmations: -1 } });
    expect(mocked.getTipHeight).not.toHaveBeenCalled();
  });

  it('waits for the block under policy -1 when the submit gave no clear answer', async () => {
    submitWithoutLanding(unknown);
    const req = requirements(-1);
    const { payload, txHash } = payment(req);
    const c = ctx({ allowMempoolConfirmation: true });
    expect(await runSettle(payload, req, c)).toMatchObject({ success: false, errorReason: Codes.PENDING });
    expect(await c.store.get(txHash)).toMatchObject({ state: 'pending', broadcast: false });
  });

  it('settles at inclusion under policy -1 after an unclear submit that landed', async () => {
    mocked.trySubmit.mockImplementation(async () => { landed = true; return unknown; });
    mocked.getTipHeight.mockResolvedValue(TX_HEIGHT);
    const req = requirements(-1);
    const { payload } = payment(req);
    const r = await runSettle(payload, req, ctx({ allowMempoolConfirmation: true }));
    expect(r).toMatchObject({ success: true, extra: { status: 'confirmed', confirmations: 0 } });
  });
});

describe('runSettle, submit outcomes', () => {
  it('records the broadcast once a backend took the tx', async () => {
    submitWithoutLanding(accepted);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    expect((await runSettle(payload, req, c)).errorReason).toBe(Codes.PENDING);
    expect(await c.store.get(txHash)).toMatchObject({ state: 'pending', broadcast: true });
  });

  it('never submits again after a backend took the tx', async () => {
    submitWithoutLanding(accepted);
    const req = requirements();
    const { payload } = payment(req);
    const c = ctx();
    expect((await runSettle(payload, req, c)).errorReason).toBe(Codes.PENDING);

    landed = true;
    const r = await runSettle(payload, req, c);
    expect(r.success).toBe(true);
    expect(r.payer).toBe(BUYER_ADDR);
    expect(r.amount).toBe(PRICE.toString());
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps the claim after an unclear submit and submits again on the retry', async () => {
    mocked.trySubmit.mockResolvedValueOnce(unknown);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const first = await runSettle(payload, req, c);
    expect(first).toMatchObject({ success: false, errorReason: Codes.PENDING, transaction: txHash });
    expect(await c.store.get(txHash)).toMatchObject({ state: 'pending', broadcast: false });

    const retry = await runSettle(payload, req, c);
    expect(retry.success).toBe(true);
    expect(mocked.trySubmit).toHaveBeenCalledTimes(2);
    expect(await c.store.get(txHash)).toMatchObject({ state: 'settled', broadcast: true });
  });

  it('settles when an unclear submit landed after all', async () => {
    mocked.trySubmit.mockImplementation(async () => { landed = true; return unknown; });
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    expect((await runSettle(payload, req, c)).success).toBe(true);
    expect((await c.store.get(txHash))?.state).toBe('settled');
  });

  it('releases the claim when the ledger refused the tx', async () => {
    submitWithoutLanding(rejected);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const r = await runSettle(payload, req, c);
    expect(r).toEqual({ success: false, errorReason: Codes.SUBMIT_FAILED, transaction: '', network: NETWORK_PREPROD, payer: BUYER_ADDR });
    expect(await c.store.get(txHash)).toBeUndefined();
    expect(mocked.getTipHeight).not.toHaveBeenCalled();
  });

  it('treats a refused submit as broadcast when the tx is on chain already', async () => {
    mocked.trySubmit.mockImplementation(async () => { landed = true; return rejected; });
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    expect((await runSettle(payload, req, c)).success).toBe(true);
    expect(await c.store.get(txHash)).toMatchObject({ state: 'settled', broadcast: true });
  });

  it('submits the signed bytes unchanged', async () => {
    const req = requirements();
    const { payload } = payment(req);
    await runSettle(payload, req, ctx());
    const sent = mocked.trySubmit.mock.calls[0]![0];
    expect(Buffer.from(sent, 'hex').toString('base64')).toBe(payload.payload.transaction);
  });
});

describe('runSettle, pending and duplicates', () => {
  it('answers settlement_pending with the tx id when the tx is not visible within the budget', async () => {
    submitWithoutLanding(accepted);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const r = await runSettle(payload, req, c);
    expect(r).toEqual({
      success: false,
      errorReason: Codes.PENDING,
      transaction: txHash,
      network: NETWORK_PREPROD,
      payer: BUYER_ADDR,
      amount: PRICE.toString(),
      extra: { status: 'pending', confirmations: -1, transactionId: txHash },
    });
    expect((await c.store.get(txHash))?.state).toBe('pending');
  });

  it('answers duplicate_settlement for an already settled tx', async () => {
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    expect((await runSettle(payload, req, c)).success).toBe(true);
    const again = await runSettle(payload, req, c);
    expect(again).toMatchObject({ success: false, errorReason: Codes.DUPLICATE_SETTLEMENT, transaction: txHash, payer: BUYER_ADDR });
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
  });

  it('lets one of two concurrent settles deliver; the other answers duplicate_settlement', async () => {
    const req = requirements();
    const { payload } = payment(req);
    const c = ctx();
    const rs = await Promise.all([runSettle(payload, req, c), runSettle(payload, req, c)]);
    expect(rs.filter(r => r.success)).toHaveLength(1);
    expect(rs.filter(r => r.errorReason === Codes.DUPLICATE_SETTLEMENT)).toHaveLength(1);
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
  });

  it('resumes a pending tx in only one of two concurrent retries', async () => {
    submitWithoutLanding(accepted);
    const req = requirements();
    const { payload } = payment(req);
    const c = ctx();
    expect((await runSettle(payload, req, c)).errorReason).toBe(Codes.PENDING);

    landed = true;
    const rs = await Promise.all([runSettle(payload, req, c), runSettle(payload, req, c)]);
    expect(rs.filter(r => r.success)).toHaveLength(1);
    expect(rs.filter(r => r.errorReason === Codes.DUPLICATE_SETTLEMENT)).toHaveLength(1);
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses to resume a pending tx for requirements it does not pay', async () => {
    submitWithoutLanding(accepted);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    await runSettle(payload, req, c);
    expect((await c.store.get(txHash))?.state).toBe('pending');

    const other = buildRequirements({ amount: PRICE * 2n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });
    const r = await runSettle(payload, other, c);
    expect(r).toMatchObject({ success: false, errorReason: Codes.ACCEPTED_MISMATCH, transaction: txHash });
    expect((await c.store.get(txHash))?.state).toBe('pending');
  });
});

describe('runSettle, claim held by another call', () => {
  const inMs = (ms: number) => Date.now() + ms;

  it('answers duplicate_settlement while the other call holds its lease', async () => {
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    await c.store.claim(txHash, inMs(600_000), inMs(60_000));
    const r = await runSettle(payload, req, c);
    expect(r).toMatchObject({ success: false, errorReason: Codes.DUPLICATE_SETTLEMENT, transaction: txHash });
    expect(mocked.trySubmit).not.toHaveBeenCalled();
    expect((await c.store.get(txHash))?.state).toBe('submitting');
  });

  it('takes the claim over once the lease ran out and settles', async () => {
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    await c.store.claim(txHash, inMs(600_000), inMs(60_000));
    await c.store.update(txHash, { leaseUntil: Date.now() - 1 });

    const r = await runSettle(payload, req, c);
    expect(r).toMatchObject({ success: true, transaction: txHash, amount: PRICE.toString() });
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
    expect((await c.store.get(txHash))?.state).toBe('settled');
  });

  it('does not submit again when the dead call had broadcast the tx', async () => {
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    await c.store.claim(txHash, inMs(600_000), inMs(60_000));
    await c.store.update(txHash, { leaseUntil: Date.now() - 1, broadcast: true });
    landed = true;

    expect((await runSettle(payload, req, c)).success).toBe(true);
    expect(mocked.trySubmit).not.toHaveBeenCalled();
  });

  it('takes a lease that outlasts its own wait, on the claim and on a resume', async () => {
    submitWithoutLanding(accepted);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const leases: number[] = [];
    const inner = memorySettlementStore();
    const store: SettlementStore = {
      ...inner,
      claim: (id, expiresAt, leaseUntil) => { leases.push(leaseUntil); return inner.claim(id, expiresAt, leaseUntil); },
      resume: (id, leaseUntil) => { leases.push(leaseUntil); return inner.resume(id, leaseUntil); },
    };
    const c = ctx({ store });
    await runSettle(payload, req, c);
    await runSettle(payload, req, c);
    expect(leases).toHaveLength(2);
    for (const until of leases) expect(until).toBeGreaterThan(Date.now() + c.pollBudgetMs);
    expect((await inner.get(txHash))?.state).toBe('pending');
  });
});

describe('runSettle, input', () => {
  it('answers a payload without a payload field with a failure, not a throw', async () => {
    const req = requirements();
    const broken = { x402Version: 2, accepted: req } as unknown as PaymentPayload;
    expect(await runSettle(broken, req, ctx())).toMatchObject({ success: false, errorReason: Codes.INVALID_PAYLOAD });
  });

  it('answers the decode error for a broken transaction', async () => {
    const req = requirements();
    const { payload } = payment(req);
    const broken: PaymentPayload = { ...payload, payload: { ...payload.payload, transaction: 'AAAA' } };
    expect((await runSettle(broken, req, ctx())).errorReason).toBe(Codes.INVALID_CBOR);
  });

  it('settles requirements that name the network by its CIP-34 alias, answering the canonical id', async () => {
    const req = requirements();
    const aliased = { ...req, network: 'cip34:0-1' as PaymentRequirements['network'] };
    const { payload } = payment(req);
    const r = await runSettle(payload, aliased, ctx());
    expect(r).toMatchObject({ success: true, network: NETWORK_PREPROD });
  });

  it('answers the verify reason and takes no claim when the payment is invalid', async () => {
    mocked.isUtxoUnspent.mockResolvedValue(false);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const r = await runSettle(payload, req, c);
    expect(r).toMatchObject({ success: false, errorReason: Codes.REPLAY, transaction: '' });
    expect(await c.store.get(txHash)).toBeUndefined();
    expect(mocked.trySubmit).not.toHaveBeenCalled();
  });
});

describe('runSettle, failures', () => {
  it('fails terminally when the tx is still missing two minutes after its TTL', async () => {
    submitWithoutLanding(accepted);
    mocked.slotToPosixMs.mockReturnValue(Date.now() - 121_000);
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx({ claimGraceMs: 3_600_000 });
    const r = await runSettle(payload, req, c);
    expect(r).toMatchObject({ success: false, errorReason: Codes.SETTLEMENT_FAILED, transaction: txHash });
    expect((await c.store.get(txHash))?.state).toBe('failed');
    expect(await runSettle(payload, req, c)).toEqual(r);
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting within the expiry grace after the TTL', async () => {
    submitWithoutLanding(accepted);
    mocked.slotToPosixMs.mockReturnValue(Date.now() - 60_000);
    const req = requirements();
    const { payload } = payment(req);
    expect((await runSettle(payload, req, ctx({ claimGraceMs: 3_600_000 }))).errorReason).toBe(Codes.PENDING);
  });

  it('fails when the tx landed as a failed script run', async () => {
    scriptFailed = true;
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const r = await runSettle(payload, req, c);
    expect(r).toMatchObject({ success: false, errorReason: Codes.PHASE2_INVALID, transaction: txHash, payer: BUYER_ADDR });
    expect((await c.store.get(txHash))?.state).toBe('failed');
    expect(mocked.getTipHeight).not.toHaveBeenCalled();
    expect(await runSettle(payload, req, c)).toEqual(r);
  });

  it('answers settlement_pending on an unexpected error while it holds the claim, so the buyer re-sends', async () => {
    mocked.getTipHeight.mockRejectedValueOnce(new Error('tip down'));
    const req = requirements();
    const { payload, txHash } = payment(req);
    const c = ctx();
    const r = await runSettle(payload, req, c);
    expect(r).toEqual({
      success: false,
      errorReason: Codes.PENDING,
      transaction: txHash,
      network: NETWORK_PREPROD,
      payer: BUYER_ADDR,
      extra: { status: 'pending', confirmations: -1, transactionId: txHash },
    });
    expect(await c.store.get(txHash)).toMatchObject({ state: 'pending', broadcast: true });

    const retry = await runSettle(payload, req, c);
    expect(retry.success).toBe(true);
    expect(mocked.trySubmit).toHaveBeenCalledTimes(1);
  });

  it('answers unexpected_settle_error without a tx id when it fails before the claim', async () => {
    const req = requirements();
    const { payload } = payment(req);
    const store: SettlementStore = { ...memorySettlementStore(), get: async () => { throw new Error('db down'); } };
    const r = await runSettle(payload, req, ctx({ store }));
    expect(r).toEqual({ success: false, errorReason: Codes.UNEXPECTED_SETTLE_ERROR, transaction: '', network: NETWORK_PREPROD });
    expect(mocked.trySubmit).not.toHaveBeenCalled();
  });
});
