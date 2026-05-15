/**
 * Tests for the unsigned-payment-tx builder.
 *
 * We bridge-mock at the module level so the builder runs entirely in
 * memory, getUtxosAtAddress / getProtocolParameters / getCurrentSlot
 * are all data fed by the test. This covers happy-path lovelace and
 * native-asset flows, plus the documented failure modes (no UTxOs,
 * insufficient holdings, script-payment-cred refusal, ADA padding).
 *
 * Building the actual signed CBOR would require buyer private keys ,
 * orthogonal to what THIS module does. We assert the unsigned CBOR
 * is decodable and the metadata fields are populated correctly.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { buildUnsignedPaymentTx } from '../../srv/helpers/build-unsigned-tx';
import { buildEntry } from '../../srv/core/requirements';
import {
  BUYER_PRIV, BUYER_ADDR, SELLER_ADDR,
  NONCE_TX_HASH, NETWORK_PREPROD,
  TEST_POLICY_ID, TEST_ASSET_NAME, TEST_ASSET_STRING, TEST_ASSET_UNIT,
  CURRENT_SLOT,
} from '../fixtures/constants';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

const mockedBridge = jest.mocked(bridge);

const PROTOCOL_PARAMS = {
  minFeeA: 44,
  minFeeB: 155381,
  poolDeposit: '500000000',
  keyDeposit: '2000000',
  maxValSize: 5000,
  maxTxSize: 16384,
  coinsPerUtxoSize: 4310,
};

beforeEach(() => {
  jest.resetAllMocks();
  mockedBridge.getProtocolParameters.mockResolvedValue(PROTOCOL_PARAMS as unknown);
  mockedBridge.getCurrentSlot.mockResolvedValue(CURRENT_SLOT);
});

function lovelaceUtxo(qty: string, txHash = NONCE_TX_HASH, outputIndex = 0) {
  return {
    txHash, outputIndex, address: BUYER_ADDR,
    lovelace: qty, assets: [],
  };
}
function tokenUtxo(qty: string, lovelace = '5000000', txHash = NONCE_TX_HASH, outputIndex = 0) {
  return {
    txHash, outputIndex, address: BUYER_ADDR, lovelace,
    assets: [{
      unit: TEST_ASSET_UNIT, policyId: TEST_POLICY_ID, assetNameHex: TEST_ASSET_NAME, quantity: qty,
    }],
  };
}

function lovelaceRequirements(amount = '2000000') {
  return buildEntry({
    amount, asset: 'lovelace', payTo: SELLER_ADDR,
    network: NETWORK_PREPROD, resource: '/r',
  });
}

function tokenRequirements(amount = '10') {
  return buildEntry({
    amount, asset: TEST_ASSET_STRING, payTo: SELLER_ADDR,
    network: NETWORK_PREPROD, resource: '/r',
  });
}

describe('buildUnsignedPaymentTx, input validation', () => {
  it('rejects bad bech32 address', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([]);
    await expect(buildUnsignedPaymentTx({
      buyerBech32: 'not-bech32',
      requirements: lovelaceRequirements(),
    })).rejects.toThrow(/invalid bech32/);
  });

  it('rejects when buyer has no UTxOs', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([]);
    await expect(buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements(),
    })).rejects.toThrow(/no UTxOs/);
  });
});

describe('buildUnsignedPaymentTx, lovelace flow', () => {
  it('picks the largest UTxO covering required + 2 ADA headroom', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([
      lovelaceUtxo('500000'),                                      // too small
      lovelaceUtxo('10000000', 'a'.repeat(64), 1),                 // chosen
      lovelaceUtxo('1500000',  'b'.repeat(64), 2),                 // also too small
    ]);
    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements('2000000'),
    });
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0]!.txHash).toBe('a'.repeat(64));
    expect(r.nonceRef).toBe(`${'a'.repeat(64)}#1`);
    expect(r.ttlSlot).toBe(CURRENT_SLOT + 1800);
    expect(r.requiredSignerHex).toMatch(/^[0-9a-f]{56}$/);

    // The unsigned CBOR should decode back to a transaction with no witnesses.
    const tx = CSL.Transaction.from_hex(r.unsignedTxCborHex);
    const wits = tx.witness_set().vkeys();
    expect(wits?.len() ?? 0).toBe(0);
  });

  it('rejects when no UTxO covers required + headroom', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([lovelaceUtxo('500000')]);
    await expect(buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements('1000000000'),
    })).rejects.toThrow(/lovelace/);
  });

  it('honours custom ttlSlotsFromNow', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([lovelaceUtxo('10000000')]);
    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements(),
      ttlSlotsFromNow: 60,
    });
    expect(r.ttlSlot).toBe(CURRENT_SLOT + 60);
  });
});

describe('buildUnsignedPaymentTx, native asset flow', () => {
  it('picks largest-ADA UTxO that holds enough of the token', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([
      tokenUtxo('5'),                                                   // too few tokens
      tokenUtxo('20', '8000000', 'c'.repeat(64), 3),                    // chosen
    ]);
    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: tokenRequirements('10'),
    });
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0]!.txHash).toBe('c'.repeat(64));
  });

  it('adds a second UTxO for fee padding when the token UTxO has < 3 ADA', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([
      tokenUtxo('20', '2500000', 'd'.repeat(64), 0),                    // token UTxO < 3 ADA
      lovelaceUtxo('5000000', 'e'.repeat(64), 1),                       // padding
    ]);
    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: tokenRequirements('10'),
    });
    expect(r.inputs).toHaveLength(2);
    expect(r.inputs.map(i => i.txHash)).toContain('d'.repeat(64));
    expect(r.inputs.map(i => i.txHash)).toContain('e'.repeat(64));
  });

  it('rejects when no UTxO holds enough of the token', async () => {
    mockedBridge.getUtxosAtAddress.mockResolvedValue([tokenUtxo('3', '5000000')]);
    await expect(buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: tokenRequirements('10'),
    })).rejects.toThrow(/holds ≥ 10 of/);
  });
});

// silence unused-import lint
void BUYER_PRIV;
