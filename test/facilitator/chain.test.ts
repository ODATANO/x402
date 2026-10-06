/**
 * Chain-side verification rules (checkOnChain): inputs exist and are
 * unspent, value conservation per asset, fee floor, min-UTxO.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { checkOnChain } from '../../srv/facilitator/chain';
import { buildRequirements } from '../../srv/core/requirements';
import { parsePaymentPayload } from '../../srv/core/payload';
import { decodePayment } from '../../srv/core/decode';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  TTL_SLOT, NETWORK_PREPROD,
  TEST_POLICY_ID, TEST_ASSET_NAME, TEST_ASSET_UNIT,
} from '../fixtures/constants';
import { buildBody, signTx, type TestInput, type TestOutput } from '../fixtures/build-tx';
import { buildPaymentSignature } from '../fixtures/envelope';
import { realParseTransaction, buyerSignedWitnesses } from '../fixtures/core-parse-mock';
import type { DecodedPayment } from '../../srv/core/types';

const mocked = jest.mocked(bridge);
const OTHER_TX = 'beef'.repeat(16);
const req = buildRequirements({ amount: 2_000_000n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });

function decoded(inputs: TestInput[], outputs: TestOutput[], fee = '200000'): DecodedPayment {
  const signed = signTx(buildBody({ inputs, outputs, fee, ttlSlot: TTL_SLOT }), [BUYER_PRIV]);
  return decodePayment(parsePaymentPayload(
    buildPaymentSignature({ accepted: req, txCborHex: signed.cborHex, nonceRef: NONCE_REF }),
  ));
}

type Amount = Array<{ unit: string; quantity: string }>;
const lovelace = (q: bigint): Amount => [{ unit: 'lovelace', quantity: q.toString() }];

/** Serve funding txs: hash → amount of its output at index 0. */
function chain(funding: Record<string, Amount>): void {
  mocked.getTransactionByHash.mockImplementation(async (hash: string) => {
    const amount = funding[hash];
    return amount ? { hash, blockHeight: 1, blockTime: 1, outputs: [{ address: BUYER_ADDR, amount, outputIndex: 0 }] } : null;
  });
}

const nonce: TestInput = { txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX };
const other: TestInput = { txHash: OTHER_TX, outputIndex: 0 };
const pay = (q = 2_000_000n): TestOutput => ({ address: SELLER_ADDR, lovelace: q.toString() });

beforeEach(() => {
  jest.resetAllMocks();
  mocked.parseTransaction.mockImplementation(realParseTransaction as typeof bridge.parseTransaction);
  mocked.verifyTxWitnesses.mockReturnValue(buyerSignedWitnesses());
  mocked.createdOutputs.mockImplementation(tx => tx.outputs.filter(o => Boolean(o.isCollateral) === (tx.spendsCollaterals === true)));
  mocked.isUtxoUnspent.mockResolvedValue(true);
  mocked.getFeeParameters.mockResolvedValue({ minFeeA: 44n, minFeeB: 155_381n, coinsPerUtxoByte: 4_310n });
});

describe('checkOnChain, inputs', () => {
  it('passes a balanced tx and returns the nonce address as payer', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_200_000n) });
    expect(await checkOnChain(decoded([nonce], [pay()]), req)).toEqual({ ok: true, payerAddr: BUYER_ADDR });
  });

  it('rejects a key-locked input the transaction is not signed for (rule 6)', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_200_000n) });
    const d = { ...decoded([nonce], [pay()]), signerKeyHashes: ['ab'.repeat(28)] };
    expect(await checkOnChain(d, req)).toMatchObject({ ok: false, code: Codes.INVALID_SIGNATURE });
  });

  it('rejects a nonce that does not exist on chain', async () => {
    chain({});
    const r = await checkOnChain(decoded([nonce], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.REPLAY });
  });

  it('rejects another input that does not exist', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(1_200_000n) });
    const r = await checkOnChain(decoded([nonce, other], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.INPUT_NOT_AVAILABLE });
  });

  it('rejects another input that is spent', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(1_200_000n), [OTHER_TX]: lovelace(1_000_000n) });
    mocked.isUtxoUnspent.mockImplementation(async (hash: string) => hash !== OTHER_TX);
    const r = await checkOnChain(decoded([nonce, other], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.INPUT_NOT_AVAILABLE });
  });

  it('skips the unspent check for a tx the ledger already accepted', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_200_000n) });
    mocked.isUtxoUnspent.mockResolvedValue(false);
    expect((await checkOnChain(decoded([nonce], [pay()]), req, { alreadyAccepted: true })).ok).toBe(true);
    expect(mocked.isUtxoUnspent).not.toHaveBeenCalled();
  });

  it('fetches each funding tx once', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_200_000n) });
    const d = decoded([nonce, { txHash: NONCE_TX_HASH, outputIndex: 1 }], [pay()]);
    await checkOnChain(d, req);
    expect(mocked.getTransactionByHash).toHaveBeenCalledTimes(1);
  });

  it('reports the first failing input in input order, whichever lookup answers first', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(1_200_000n), [OTHER_TX]: lovelace(1_000_000n) });
    mocked.isUtxoUnspent.mockImplementation(async (hash: string) => {
      if (hash === NONCE_TX_HASH) await new Promise(r => setTimeout(r, 20));
      return false;
    });
    const r = await checkOnChain(decoded([nonce, other], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.REPLAY });
  });
});

describe('checkOnChain, outputs a funding tx created', () => {
  /** A funding tx with a regular output and a collateral return, both at index 0 of their kind. */
  function fundingWithCollateral(spendsCollaterals: boolean): void {
    mocked.getTransactionByHash.mockImplementation(async (hash: string) => (hash !== NONCE_TX_HASH ? null : {
      hash, blockHeight: 1, blockTime: 1, spendsCollaterals,
      outputs: [
        { address: BUYER_ADDR, amount: lovelace(2_200_000n), outputIndex: 0 },
        { address: BUYER_ADDR, amount: lovelace(4_000_000n), outputIndex: 1, isCollateral: true },
      ],
    }));
  }
  const collateralReturn: TestInput = { txHash: NONCE_TX_HASH, outputIndex: 1 };

  it('does not find the collateral return of a valid tx', async () => {
    fundingWithCollateral(false);
    const r = await checkOnChain(decoded([nonce, collateralReturn], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.INPUT_NOT_AVAILABLE });
    if (!r.ok) expect(r.reason).toContain(`${NONCE_TX_HASH}#1`);
    expect(mocked.isUtxoUnspent).not.toHaveBeenCalledWith(NONCE_TX_HASH, 1);
  });

  it('finds the regular output of a valid tx', async () => {
    fundingWithCollateral(false);
    expect(await checkOnChain(decoded([nonce], [pay()]), req)).toEqual({ ok: true, payerAddr: BUYER_ADDR });
  });

  it('finds only the collateral return of a tx whose script failed', async () => {
    fundingWithCollateral(true);
    const regular = await checkOnChain(decoded([nonce], [pay()]), req);
    expect(regular).toMatchObject({ ok: false, code: Codes.REPLAY });

    // 4 ADA collateral return in, 2 ADA paid, 200_000 fee, rest back as change.
    const change: TestOutput = { address: BUYER_ADDR, lovelace: '1800000' };
    const d = decoded([collateralReturn], [pay(), change]);
    d.nonce = { txHash: NONCE_TX_HASH, index: 1 };
    expect(await checkOnChain(d, req)).toEqual({ ok: true, payerAddr: BUYER_ADDR });
  });
});

describe('checkOnChain, value conservation', () => {
  it('rejects a lovelace imbalance', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_300_000n) });
    const r = await checkOnChain(decoded([nonce], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.VALUE_NOT_CONSERVED });
    if (!r.ok) expect(r.reason).toMatch(/^lovelace/);
  });

  it('rejects a native asset that the inputs carry but the outputs drop', async () => {
    chain({ [NONCE_TX_HASH]: [...lovelace(2_200_000n), { unit: TEST_ASSET_UNIT, quantity: '5' }] });
    const r = await checkOnChain(decoded([nonce], [pay()]), req);
    expect(r).toMatchObject({ ok: false, code: Codes.VALUE_NOT_CONSERVED });
    if (!r.ok) expect(r.reason).toContain(TEST_ASSET_UNIT);
  });

  it('passes native assets that balance', async () => {
    chain({ [NONCE_TX_HASH]: [...lovelace(2_200_000n), { unit: TEST_ASSET_UNIT, quantity: '5' }] });
    const outputs: TestOutput[] = [{ ...pay(), assets: [{ policyId: TEST_POLICY_ID, nameHex: TEST_ASSET_NAME, qty: '5' }] }];
    expect((await checkOnChain(decoded([nonce], outputs), req)).ok).toBe(true);
  });
});

describe('checkOnChain, fee floor and min-UTxO', () => {
  it('rejects a fee below minFeeB + minFeeA * size', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_100_000n) });
    const r = await checkOnChain(decoded([nonce], [pay()], '100000'), req);
    expect(r).toMatchObject({ ok: false, code: Codes.FEE_BELOW_MINIMUM });
  });

  it('rejects a payTo output below min-UTxO when its size is known', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(1_200_000n) });
    const d = decoded([nonce], [pay(1_000_000n)]);
    d.outputs[0]!.cborSize = 100; // (160 + 100) * 4310 = 1_120_600
    const r = await checkOnChain(d, req);
    expect(r).toMatchObject({ ok: false, code: Codes.MIN_UTXO_INSUFFICIENT });
  });

  it('skips min-UTxO without an output size or without coinsPerUtxoByte', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(1_200_000n) });
    const unsized = decoded([nonce], [pay(1_000_000n)]);
    delete unsized.outputs[0]!.cborSize;
    expect((await checkOnChain(unsized, req)).ok).toBe(true);
    mocked.getFeeParameters.mockResolvedValue({ minFeeA: 44n, minFeeB: 155_381n, coinsPerUtxoByte: null });
    const d = decoded([nonce], [pay(1_000_000n)]);
    d.outputs[0]!.cborSize = 100;
    expect((await checkOnChain(d, req)).ok).toBe(true);
  });

  it('accepts a payTo output at its min-UTxO, measured from the parsed size', async () => {
    chain({ [NONCE_TX_HASH]: lovelace(2_200_000n) });
    const d = decoded([nonce], [pay()]);
    const size = d.outputs[0]!.cborSize;
    expect(size).toBeGreaterThan(0);
    expect(BigInt(d.outputs[0]!.lovelace)).toBeGreaterThanOrEqual((160n + BigInt(size!)) * 4_310n);
    expect((await checkOnChain(d, req)).ok).toBe(true);
  });
});
