/**
 * Facilitator `/verify` (runVerify) against a mocked chain. The payment tx
 * is real CBOR built and signed with buildooor; the bridge serves the
 * nonce's funding tx, slots and fee parameters.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { runVerify, type VerifyContext } from '../../srv/facilitator/verify';
import { memorySettlementStore } from '../../srv/facilitator/store';
import { buildRequirements } from '../../srv/core/requirements';
import { parsePaymentPayload } from '../../srv/core/payload';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  CURRENT_SLOT, TTL_SLOT, MAX_TTL_SLOT,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import { buildBody, signTx, type TestOutput } from '../fixtures/build-tx';
import { buildPaymentSignature } from '../fixtures/envelope';
import { realParseTransaction, buyerSignedWitnesses } from '../fixtures/core-parse-mock';
import type { PaymentPayload, PaymentRequirements } from '../../srv/core/types';

const mocked = jest.mocked(bridge);

const PRICE = 2_000_000n;
const FEE = 200_000n;
const FUNDING = 10_000_000n;

const requirements = (extra?: PaymentRequirements['extra']): PaymentRequirements => buildRequirements({
  amount: PRICE, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD,
  ...(extra ? { extra } : {}),
});

/** A balanced payment: FUNDING in, PRICE to the seller, change back, FEE. */
function payment(opts: {
  outputs?: TestOutput[];
  ttlSlot?: number;
  req?: PaymentRequirements;
} = {}): { payload: PaymentPayload; txHash: string; req: PaymentRequirements } {
  const req = opts.req ?? requirements();
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: opts.outputs ?? [
      { address: SELLER_ADDR, lovelace: PRICE.toString() },
      { address: BUYER_ADDR, lovelace: (FUNDING - PRICE - FEE).toString() },
    ],
    fee: FEE.toString(),
    ttlSlot: opts.ttlSlot ?? TTL_SLOT,
  });
  const signed = signTx(body, [BUYER_PRIV]);
  const header = buildPaymentSignature({ accepted: req, txCborHex: signed.cborHex, nonceRef: NONCE_REF });
  return { payload: parsePaymentPayload(header), txHash: signed.txHash, req };
}

/** The tx that created the nonce UTxO, as core's getTransaction returns it. */
function fundingTx(amount: Array<{ unit: string; quantity: string }> = [{ unit: 'lovelace', quantity: FUNDING.toString() }]) {
  return {
    hash: NONCE_TX_HASH, blockHeight: 90, blockTime: 1_700_000_000,
    outputs: [{ address: BUYER_ADDR, amount, outputIndex: NONCE_INDEX }],
  };
}

function ctx(allowMempoolConfirmation = false): VerifyContext {
  return { store: memorySettlementStore(), allowMempoolConfirmation };
}

beforeEach(() => {
  jest.resetAllMocks();
  mocked.parseTransaction.mockImplementation(realParseTransaction as typeof bridge.parseTransaction);
  mocked.verifyTxWitnesses.mockReturnValue(buyerSignedWitnesses());
  mocked.createdOutputs.mockImplementation(tx => tx.outputs.filter(o => Boolean(o.isCollateral) === (tx.spendsCollaterals === true)));
  mocked.getCurrentSlot.mockResolvedValue(CURRENT_SLOT);
  mocked.posixToSlot.mockReturnValue(MAX_TTL_SLOT);
  mocked.isUtxoUnspent.mockResolvedValue(true);
  mocked.getFeeParameters.mockResolvedValue({ minFeeA: 44n, minFeeB: 155_381n, coinsPerUtxoByte: 4_310n });
  mocked.getTransactionByHash.mockImplementation(async (hash: string) => (hash === NONCE_TX_HASH ? fundingTx() : null));
});

describe('runVerify, valid payment', () => {
  it('is valid and names the payer from the nonce output', async () => {
    const { payload, req } = payment();
    const r = await runVerify(payload, req, ctx());
    expect(r.response).toEqual({ isValid: true, payer: BUYER_ADDR });
    expect(r.match?.amountUnits).toBe(PRICE.toString());
    expect(mocked.submitTransaction).not.toHaveBeenCalled();
  });

  it('bounds the TTL with now + maxTimeoutSeconds', async () => {
    const { payload, req } = payment();
    await runVerify(payload, req, ctx());
    const [network, posixMs] = mocked.posixToSlot.mock.calls[0]!;
    expect(network).toBe(NETWORK_PREPROD);
    expect(Math.abs(posixMs - (Date.now() + 600_000))).toBeLessThan(5_000);
  });
});

describe('runVerify, requirements', () => {
  it('rejects l1Confirmations -1 unless the facilitator opted in', async () => {
    const req = requirements({ confirmationPolicy: { l1Confirmations: -1 } });
    const { payload } = payment({ req });
    expect((await runVerify(payload, req, ctx())).response.invalidReason).toBe(Codes.INVALID_POLICY);
    expect((await runVerify(payload, req, ctx(true))).response.isValid).toBe(true);
  });

  it('rejects an out-of-range policy', async () => {
    const req = requirements();
    const bad = { ...req, extra: { ...req.extra, confirmationPolicy: { l1Confirmations: 21 } } };
    const { payload } = payment({ req: bad });
    expect((await runVerify(payload, bad, ctx())).response.invalidReason).toBe(Codes.INVALID_POLICY);
  });

  it('rejects an unsupported scheme, network or transfer method', async () => {
    const req = requirements();
    const { payload } = payment();
    const cases: Array<[PaymentRequirements, string]> = [
      [{ ...req, scheme: 'upto' } as unknown as PaymentRequirements, Codes.UNSUPPORTED_SCHEME],
      [{ ...req, network: 'eip155:8453' } as unknown as PaymentRequirements, Codes.INVALID_NETWORK_FORMAT],
      [{ ...req, extra: { assetTransferMethod: 'masumi' } } as unknown as PaymentRequirements, Codes.UNSUPPORTED_METHOD],
    ];
    for (const [r, code] of cases) {
      expect((await runVerify(payload, r, ctx())).response.invalidReason).toBe(code);
    }
  });

  it('rejects when accepted differs from the requirements', async () => {
    const { payload } = payment();
    const other = buildRequirements({ amount: 3_000_000n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });
    expect((await runVerify(payload, other, ctx())).response.invalidReason).toBe(Codes.ACCEPTED_MISMATCH);
  });

  it('treats a CIP-34 alias in accepted as the canonical network', async () => {
    const { payload, req } = payment();
    const aliased = { ...payload, accepted: { ...payload.accepted, network: 'cip34:0-1' } } as unknown as PaymentPayload;
    expect((await runVerify(aliased, req, ctx())).response.isValid).toBe(true);
  });
});

describe('runVerify, backend network', () => {
  it.each([undefined, null])('does not check the network when the backend reports %s', async (reported) => {
    mocked.getBackendNetwork.mockResolvedValue(reported as unknown as string | null);
    const { payload, req } = payment();
    expect((await runVerify(payload, req, ctx())).response.isValid).toBe(true);
  });

  it('verifies a payment on the network the backend serves', async () => {
    mocked.getBackendNetwork.mockResolvedValue(NETWORK_PREPROD);
    const { payload, req } = payment();
    expect((await runVerify(payload, req, ctx())).response.isValid).toBe(true);
  });

  it('rejects requirements for a network the backend does not serve, before any chain lookup', async () => {
    mocked.getBackendNetwork.mockResolvedValue('cardano:preview');
    const { payload, req } = payment();
    const r = await runVerify(payload, req, ctx());
    expect(r.response).toMatchObject({ isValid: false, invalidReason: Codes.INVALID_NETWORK_FORMAT });
    expect(r.response.extra?.reason).toMatch(/cardano:preview.*cardano:preprod/);
    expect(mocked.getTransactionByHash).not.toHaveBeenCalled();
    expect(mocked.isUtxoUnspent).not.toHaveBeenCalled();
  });

  it('compares the canonical id, so a CIP-34 alias of the served network passes', async () => {
    mocked.getBackendNetwork.mockResolvedValue(NETWORK_PREPROD);
    const { payload, req } = payment();
    const aliased = { ...req, network: 'cip34:0-1' as typeof req.network };
    expect((await runVerify(payload, aliased, ctx())).response.isValid).toBe(true);
  });

  it('turns a failing backend lookup into unexpected_verify_error', async () => {
    mocked.getBackendNetwork.mockRejectedValue(new Error('core not initialized'));
    const { payload, req } = payment();
    expect((await runVerify(payload, req, ctx())).response.invalidReason).toBe(Codes.UNEXPECTED_VERIFY_ERROR);
  });
});

describe('runVerify, payload', () => {
  it('rejects a transaction that does not decode', async () => {
    const { payload, req } = payment();
    const broken: PaymentPayload = { ...payload, payload: { ...payload.payload, transaction: 'AAAA' } };
    expect((await runVerify(broken, req, ctx())).response.invalidReason).toBe(Codes.INVALID_CBOR);
  });

  it('runs the structural rules', async () => {
    const { payload, req } = payment({ outputs: [{ address: BUYER_ADDR, lovelace: (FUNDING - FEE).toString() }] });
    expect((await runVerify(payload, req, ctx())).response.invalidReason).toBe(Codes.WRONG_RECIPIENT);
  });

  it('rejects a TTL beyond now + maxTimeoutSeconds', async () => {
    const { payload, req } = payment({ ttlSlot: MAX_TTL_SLOT + 1 });
    expect((await runVerify(payload, req, ctx())).response.invalidReason).toBe(Codes.TTL_TOO_FAR);
  });
});

describe('runVerify, settlement claims', () => {
  it('rejects a transaction this facilitator already settled', async () => {
    const { payload, req, txHash } = payment();
    const c = ctx();
    await c.store.claim(txHash, Date.now() + 60_000, Date.now() + 60_000);
    await c.store.update(txHash, { state: 'settled' });
    expect((await runVerify(payload, req, c)).response.invalidReason).toBe(Codes.DUPLICATE_SETTLEMENT);
  });

  it('accepts an in-flight claim whose tx the ledger accepted, despite spent inputs and passed TTL', async () => {
    const { payload, req, txHash } = payment();
    const c = ctx();
    await c.store.claim(txHash, Date.now() + 60_000, Date.now() + 60_000);
    await c.store.update(txHash, { state: 'pending' });
    mocked.getTransactionByHash.mockImplementation(async (hash: string) =>
      hash === NONCE_TX_HASH ? fundingTx() : hash === txHash ? { hash, blockHeight: 100, blockTime: 1, outputs: [] } : null);
    mocked.isUtxoUnspent.mockResolvedValue(false);
    mocked.getCurrentSlot.mockResolvedValue(TTL_SLOT + 10);
    expect((await runVerify(payload, req, c)).response.isValid).toBe(true);
  });

  it('skips the unspent check for an in-flight claim even before an indexer shows the tx', async () => {
    const { payload, req, txHash } = payment();
    const c = ctx();
    await c.store.claim(txHash, Date.now() + 60_000, Date.now() + 60_000);
    mocked.isUtxoUnspent.mockResolvedValue(false);
    expect((await runVerify(payload, req, c)).response.isValid).toBe(true);
  });

  it('answers a payload without a payload field as invalid_payload', async () => {
    const { req } = payment();
    const broken = { x402Version: 2, accepted: req } as unknown as Parameters<typeof runVerify>[0];
    expect((await runVerify(broken, req, ctx())).response).toMatchObject({ isValid: false, invalidReason: Codes.INVALID_PAYLOAD });
  });

  it('verifies requirements that name the network by its CIP-34 alias', async () => {
    const { payload, req } = payment();
    const aliased = { ...req, network: 'cip34:0-1' as typeof req.network };
    expect((await runVerify(payload, aliased, ctx())).response.isValid).toBe(true);
  });
});

describe('runVerify, chain rules', () => {
  it('rejects a spent nonce', async () => {
    const { payload, req } = payment();
    mocked.isUtxoUnspent.mockResolvedValue(false);
    expect((await runVerify(payload, req, ctx())).response.invalidReason).toBe(Codes.REPLAY);
  });

  it('rejects a value imbalance', async () => {
    const { payload, req } = payment();
    mocked.getTransactionByHash.mockImplementation(async (hash: string) =>
      hash === NONCE_TX_HASH ? fundingTx([{ unit: 'lovelace', quantity: (FUNDING + 1n).toString() }]) : null);
    expect((await runVerify(payload, req, ctx())).response.invalidReason).toBe(Codes.VALUE_NOT_CONSERVED);
  });

  it('turns a backend failure into unexpected_verify_error', async () => {
    const { payload, req } = payment();
    mocked.getCurrentSlot.mockRejectedValue(new Error('backend down'));
    const r = await runVerify(payload, req, ctx());
    expect(r.response.invalidReason).toBe(Codes.UNEXPECTED_VERIFY_ERROR);
    expect(r.response.extra?.reason).toMatch(/backend down/);
  });
});
