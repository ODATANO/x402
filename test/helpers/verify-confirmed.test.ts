/**
 * Tests for the post-paid verifier. The bridge is mocked; the transaction
 * stubs have the shape `@odatano/core` returns (`outputs[].amount[]`).
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());
// The real `createdOutputs` is pure; loading the real bridge needs the core barrel stubbed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import * as bridge from '../../srv/bridge';
import { verifyConfirmedPayment, type VerifyConfirmedArgs } from '../../srv/helpers/verify-confirmed';
import { Codes } from '../../srv/core/errors';
import {
  SELLER_ADDR, BUYER_ADDR,
  TEST_ASSET_STRING, TEST_ASSET_UNIT,
  USDM_PREPROD_ASSET,
  NETWORK_PREPROD,
} from '../fixtures/constants';

const mockedBridge = jest.mocked(bridge);
const realBridge = jest.requireActual<typeof bridge>('../../srv/bridge');

const VALID_TX = 'ab'.repeat(32);

type Amount = bridge.ChainTxOutput['amount'];
const lovelace = (q: string): Amount => [{ unit: 'lovelace', quantity: q }];
/** A native-asset output: the token plus its riding min-ADA. */
const token = (q: string, unit: string = TEST_ASSET_UNIT): Amount =>
  [{ unit: 'lovelace', quantity: '1200000' }, { unit, quantity: q }];

interface OutputStub { address: string; amount: Amount; isCollateral?: boolean }

/** A transaction as core reports it; outputs are numbered in order. */
function chainTx(outputs: OutputStub[], over: Partial<bridge.ChainTx> = {}): bridge.ChainTx {
  return {
    hash:        VALID_TX,
    blockHeight: 100,
    blockTime:   1_700_000_000,
    outputs:     outputs.map((o, outputIndex) => ({ ...o, outputIndex })),
    ...over,
  };
}

function args(over: Partial<VerifyConfirmedArgs> = {}): VerifyConfirmedArgs {
  return {
    txHash: VALID_TX,
    requiredAmount: '1000000',
    asset: 'lovelace',
    payTo: SELLER_ADDR,
    network: NETWORK_PREPROD,
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockedBridge.createdOutputs.mockImplementation(realBridge.createdOutputs);
});

describe('verifyConfirmedPayment, input validation', () => {
  it('rejects a malformed txHash', async () => {
    const r = await verifyConfirmedPayment(args({ txHash: 'short' }));
    expect(r).toMatchObject({ ok: false, code: Codes.INVALID_CBOR });
    expect(mockedBridge.getTransactionByHash).not.toHaveBeenCalled();
  });

  it('rejects a non-hex txHash', async () => {
    const r = await verifyConfirmedPayment(args({ txHash: 'zz'.repeat(32) }));
    expect(r).toMatchObject({ ok: false, code: Codes.INVALID_CBOR });
  });

  it('rejects an unknown network', async () => {
    const r = await verifyConfirmedPayment(args({ network: 'cardano-preprod' }));
    expect(r).toMatchObject({ ok: false, code: Codes.INVALID_NETWORK_FORMAT });
  });

  it('rejects a malformed asset', async () => {
    const r = await verifyConfirmedPayment(args({ asset: 'not-a-real-asset' }));
    expect(r).toMatchObject({ ok: false, code: Codes.INVALID_ASSET_FORMAT });
  });
});

describe('verifyConfirmedPayment, chain lookup', () => {
  it('answers pending when the tx is not on chain yet', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(null);
    const r = await verifyConfirmedPayment(args());
    expect(r).toMatchObject({ ok: false, code: Codes.PENDING });
    if (!r.ok) expect(r.reason).toMatch(/not found on-chain/);
  });

  it('answers pending when the bridge fails', async () => {
    mockedBridge.getTransactionByHash.mockRejectedValue(new Error('blockfrost down'));
    const r = await verifyConfirmedPayment(args());
    expect(r).toMatchObject({ ok: false, code: Codes.PENDING });
    if (!r.ok) expect(r.reason).toMatch(/blockfrost down/);
  });
});

describe('verifyConfirmedPayment, lovelace', () => {
  it('accepts when payTo receives the required amount', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: lovelace('1500000') },
      { address: BUYER_ADDR,  amount: lovelace('8000000') },
    ]));
    expect(await verifyConfirmedPayment(args())).toEqual({ ok: true, txHash: VALID_TX, amountUnits: '1500000' });
  });

  it('sums the outputs to payTo and ignores other addresses', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: lovelace('600000') },
      { address: BUYER_ADDR,  amount: lovelace('9000000') },
      { address: SELLER_ADDR, amount: lovelace('500000') },
    ]));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: true, amountUnits: '1100000' });
  });

  it('counts the lovelace riding on a native-asset output', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([{ address: SELLER_ADDR, amount: token('5') }]));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: true, amountUnits: '1200000' });
  });

  it('answers insufficient when payTo receives too little', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([{ address: SELLER_ADDR, amount: lovelace('999999') }]));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: false, code: Codes.INSUFFICIENT_AMOUNT });
  });

  it('answers wrong asset when nothing reaches payTo', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([{ address: BUYER_ADDR, amount: lovelace('5000000') }]));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: false, code: Codes.WRONG_ASSET });
  });

  it('answers wrong asset for a tx without outputs', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([]));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: false, code: Codes.WRONG_ASSET });
  });
});

describe('verifyConfirmedPayment, native asset', () => {
  const tokenArgs = (requiredAmount: string) => args({ asset: TEST_ASSET_STRING, requiredAmount });

  it('sums the asset across the outputs to payTo', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: token('6') },
      { address: SELLER_ADDR, amount: token('5') },
      { address: BUYER_ADDR,  amount: token('100') },
    ]));
    expect(await verifyConfirmedPayment(tokenArgs('10'))).toEqual({ ok: true, txHash: VALID_TX, amountUnits: '11' });
  });

  it('matches the unit case-insensitively', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: token('10', TEST_ASSET_UNIT.toUpperCase()) },
    ]));
    expect(await verifyConfirmedPayment(tokenArgs('10'))).toMatchObject({ ok: true, amountUnits: '10' });
  });

  it('answers insufficient when payTo receives too little of the asset', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([{ address: SELLER_ADDR, amount: token('9') }]));
    expect(await verifyConfirmedPayment(tokenArgs('10'))).toMatchObject({ ok: false, code: Codes.INSUFFICIENT_AMOUNT });
  });

  it('answers wrong asset when payTo receives only lovelace', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([{ address: SELLER_ADDR, amount: lovelace('5000000') }]));
    expect(await verifyConfirmedPayment(tokenArgs('10'))).toMatchObject({ ok: false, code: Codes.WRONG_ASSET });
  });

  it('answers wrong asset when payTo receives another token', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([{ address: SELLER_ADDR, amount: token('50') }]));
    const r = await verifyConfirmedPayment(args({ asset: USDM_PREPROD_ASSET, requiredAmount: '10' }));
    expect(r).toMatchObject({ ok: false, code: Codes.WRONG_ASSET });
  });
});

describe('verifyConfirmedPayment, collateral', () => {
  it('ignores the collateral return of a valid tx', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: lovelace('400000') },
      { address: SELLER_ADDR, amount: lovelace('5000000'), isCollateral: true },
    ]));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: false, code: Codes.INSUFFICIENT_AMOUNT });
  });

  it('does not count the regular outputs of a failed-script tx', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: lovelace('5000000') },
      { address: BUYER_ADDR,  amount: lovelace('3000000'), isCollateral: true },
    ], { spendsCollaterals: true }));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: false, code: Codes.WRONG_ASSET });
  });

  it('counts only the collateral return of a failed-script tx', async () => {
    mockedBridge.getTransactionByHash.mockResolvedValue(chainTx([
      { address: SELLER_ADDR, amount: lovelace('9000000') },
      { address: SELLER_ADDR, amount: lovelace('1000000'), isCollateral: true },
    ], { spendsCollaterals: true }));
    expect(await verifyConfirmedPayment(args())).toMatchObject({ ok: true, amountUnits: '1000000' });
  });
});
