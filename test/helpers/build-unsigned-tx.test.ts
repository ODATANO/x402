/**
 * Tests for the unsigned-payment-tx builder.
 *
 * Since v0.4 the actual build (UTxO fetch, coin selection, change,
 * min-ADA, fee) is delegated to @odatano/core's Buildooor builder via
 * `bridge.buildUnsignedTransfer`. This helper now owns only the x402
 * glue, so the tests assert that glue:
 *   - the v2 requirement is translated into the right core request
 *     (sender/recipient/change, lovelace vs native-asset, validity);
 *   - the buyer's `requiredSignerHex` is derived from the bech32 address
 *     (real `parsePaymentAddress`, no mock) and bad/unsupported addresses
 *     are rejected;
 *   - the v2 `nonceRef` and `ttlSlot` are read back from the built tx.
 *
 * Coin-selection behaviour itself is core's concern and covered there.
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { buildUnsignedPaymentTx } from '../../srv/helpers/build-unsigned-tx';
import { buildEntry } from '../../srv/core/requirements';
import {
  BUYER_ADDR, BUYER_VKH, SELLER_ADDR,
  NETWORK_PREPROD,
  TEST_ASSET_STRING, TEST_ASSET_UNIT,
  CURRENT_SLOT,
} from '../fixtures/constants';
import { bech32 } from 'bech32';

const mockedBridge = jest.mocked(bridge);

/** Build a bech32 address from a raw Shelley header byte + 28-byte cred. */
function craftAddr(prefix: string, headerByte: number, credHex: string): string {
  const bytes = Uint8Array.from([headerByte, ...Buffer.from(credHex, 'hex')]);
  return bech32.encode(prefix, bech32.toWords(bytes), 1023);
}

/** Minimal ParsedTx the builder reads back (inputs[0] → nonce, validityEnd → ttl). */
function parsed(opts: {
  inputs: Array<{ txHash: string; outputIndex: number }>;
  validityEnd: string | null;
}) {
  return {
    txHash: 'ab'.repeat(32),
    network: 'testnet',
    inputs: opts.inputs,
    outputs: [],
    validityStart: null,
    validityEnd: opts.validityEnd,
    fee: '180000',
    mint: [],
    requiredSigners: [],
    scriptDataHash: null,
    witnesses: { vkeyCount: 0, nativeScripts: 0, plutusScripts: 0, plutusData: 0, redeemers: 0 },
  } as unknown as ReturnType<typeof bridge.parseTransaction>;
}

function coreResult(opts: {
  inputs: Array<{ txHash: string; index: number; lovelace: string }>;
}) {
  return {
    unsignedTxCbor: 'aa'.repeat(80),
    txBodyHash:     'FF'.repeat(32), // upper-case → builder must lower-case it
    inputs:         opts.inputs,
    outputs:        [{ address: SELLER_ADDR, lovelace: '2000000' }],
    feeLovelace:    '180000',
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

beforeEach(() => {
  jest.resetAllMocks();
});

describe('buildUnsignedPaymentTx, address validation', () => {
  it('rejects bad bech32 address before any build call', async () => {
    await expect(buildUnsignedPaymentTx({
      buyerBech32: 'not-bech32',
      requirements: lovelaceRequirements(),
    })).rejects.toThrow(/invalid bech32/);
    expect(mockedBridge.buildUnsignedTransfer).not.toHaveBeenCalled();
  });

  it('rejects script-cred-only addresses (no VKey hash)', async () => {
    // Enterprise (type 7), testnet (net 0) → header 0x70, script payment cred.
    const scriptAddr = craftAddr('addr_test', 0x70, '11'.repeat(28));
    await expect(buildUnsignedPaymentTx({
      buyerBech32: scriptAddr,
      requirements: lovelaceRequirements(),
    })).rejects.toThrow(/VKey hash, not a script/);
  });

  it('rejects reward / stake addresses (neither Base nor Enterprise)', async () => {
    // Reward (type 14), testnet (net 0) → header 0xe0.
    const stakeAddr = craftAddr('stake_test', 0xe0, '22'.repeat(28));
    await expect(buildUnsignedPaymentTx({
      buyerBech32: stakeAddr,
      requirements: lovelaceRequirements(),
    })).rejects.toThrow(/Base \/ Enterprise/);
  });
});

describe('buildUnsignedPaymentTx, lovelace flow', () => {
  it('translates an ADA requirement into a plain-ADA core request', async () => {
    mockedBridge.buildUnsignedTransfer.mockResolvedValue(
      coreResult({ inputs: [{ txHash: 'a'.repeat(64), index: 1, lovelace: '10000000' }] }),
    );
    mockedBridge.parseTransaction.mockReturnValue(
      parsed({ inputs: [{ txHash: 'a'.repeat(64), outputIndex: 1 }], validityEnd: String(CURRENT_SLOT + 1800) }),
    );

    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements('2000000'),
    });

    const req = mockedBridge.buildUnsignedTransfer.mock.calls[0]![0];
    expect(req.senderAddress).toBe(BUYER_ADDR);
    expect(req.recipientAddress).toBe(SELLER_ADDR);
    expect(req.changeAddress).toBe(BUYER_ADDR);
    expect(req.lovelaceAmount).toBe('2000000');
    expect(req.assets).toBeUndefined();
    expect(typeof req.validityEndMs).toBe('number');

    expect(r.unsignedTxCborHex).toBe('aa'.repeat(80));
    expect(r.txHashHex).toBe('ff'.repeat(32));               // lower-cased
    expect(r.requiredSignerHex).toBe(BUYER_VKH);
    expect(r.requiredSignerHex).toMatch(/^[0-9a-f]{56}$/);
    expect(r.nonceRef).toBe(`${'a'.repeat(64)}#1`);          // from parsed inputs[0]
    expect(r.ttlSlot).toBe(CURRENT_SLOT + 1800);             // from parsed validityEnd
    expect(r.inputs).toEqual([{ txHash: 'a'.repeat(64), outputIndex: 1, lovelace: '10000000' }]);
  });

  it('sets validityEndMs from ttlSlotsFromNow (1s slots)', async () => {
    mockedBridge.buildUnsignedTransfer.mockResolvedValue(
      coreResult({ inputs: [{ txHash: 'a'.repeat(64), index: 0, lovelace: '10000000' }] }),
    );
    mockedBridge.parseTransaction.mockReturnValue(
      parsed({ inputs: [{ txHash: 'a'.repeat(64), outputIndex: 0 }], validityEnd: String(CURRENT_SLOT + 60) }),
    );

    const before = Date.now();
    await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements(),
      ttlSlotsFromNow: 60,
    });
    const after = Date.now();

    const req = mockedBridge.buildUnsignedTransfer.mock.calls[0]![0];
    // 60 slots ≈ 60_000 ms ahead of "now".
    expect(req.validityEndMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(req.validityEndMs).toBeLessThanOrEqual(after + 60_000);
  });
});

describe('buildUnsignedPaymentTx, native asset flow', () => {
  it('translates a token requirement into a multi-asset core request with riding min-ADA', async () => {
    mockedBridge.buildUnsignedTransfer.mockResolvedValue(
      coreResult({ inputs: [{ txHash: 'c'.repeat(64), index: 3, lovelace: '8000000' }] }),
    );
    mockedBridge.parseTransaction.mockReturnValue(
      parsed({ inputs: [{ txHash: 'c'.repeat(64), outputIndex: 3 }], validityEnd: String(CURRENT_SLOT + 1800) }),
    );

    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: tokenRequirements('10'),
    });

    const req = mockedBridge.buildUnsignedTransfer.mock.calls[0]![0];
    expect(req.lovelaceAmount).toBe('2000000');              // TOKEN_OUTPUT_LOVELACE
    expect(req.assets).toEqual([{ unit: TEST_ASSET_UNIT, quantity: '10' }]);
    expect(r.nonceRef).toBe(`${'c'.repeat(64)}#3`);
  });
});

describe('buildUnsignedPaymentTx, builder edge cases', () => {
  it('throws if the builder returns a tx with no inputs', async () => {
    mockedBridge.buildUnsignedTransfer.mockResolvedValue(coreResult({ inputs: [] }));
    mockedBridge.parseTransaction.mockReturnValue(parsed({ inputs: [], validityEnd: null }));
    await expect(buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements(),
    })).rejects.toThrow(/no inputs/);
  });

  it('returns ttlSlot = null when the built tx carries no TTL', async () => {
    mockedBridge.buildUnsignedTransfer.mockResolvedValue(
      coreResult({ inputs: [{ txHash: 'a'.repeat(64), index: 0, lovelace: '10000000' }] }),
    );
    mockedBridge.parseTransaction.mockReturnValue(
      parsed({ inputs: [{ txHash: 'a'.repeat(64), outputIndex: 0 }], validityEnd: null }),
    );
    const r = await buildUnsignedPaymentTx({
      buyerBech32: BUYER_ADDR,
      requirements: lovelaceRequirements(),
    });
    expect(r.ttlSlot).toBeNull();
  });
});
