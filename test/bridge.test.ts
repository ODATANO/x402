/**
 * Tests for srv/bridge.ts, the thin adapter over `@odatano/core`.
 *
 * We mock `@odatano/core` at the module level so the bridge sees a
 * deterministic surface, then exercise each public method including
 * the input-validation throws and the 404 → null translation.
 */

const mockClient = {
  getAddressUtxos:       jest.fn(),
  getTransaction:        jest.fn(),
  getProtocolParameters: jest.fn(),
  submitTransaction:     jest.fn(),
  getCurrentSlot:        jest.fn(),
  isUtxoUnspent:         jest.fn(),
  getLatestBlock:        jest.fn(),
};
const mockTxBuilder = {
  buildSimpleAdaTransaction:  jest.fn(),
  buildMultiAssetTransaction: jest.fn(),
};
const mockInitialize    = jest.fn();
const mockShutdown      = jest.fn();
const mockParseTransaction = jest.fn();
const mockPosixToSlot = jest.fn();
const mockSlotToPosixMs = jest.fn();
const mockApplyScriptParameters = jest.fn();
const mockPlutusScriptHash = jest.fn();
const mockVerifyTxWitnesses = jest.fn();
const mockGetStatus = jest.fn();

function fullCoreMock() {
  return {
    initialize:            (...a: unknown[]) => mockInitialize(...a),
    shutdown:              (...a: unknown[]) => mockShutdown(...a),
    getCardanoClient:      () => mockClient,
    getCardanoTxBuilder:   () => mockTxBuilder,
    parseTransaction:      (...a: unknown[]) => mockParseTransaction(...a),
    posixToSlot:           (...a: unknown[]) => mockPosixToSlot(...a),
    slotToPosixMs:         (...a: unknown[]) => mockSlotToPosixMs(...a),
    applyScriptParameters: (...a: unknown[]) => mockApplyScriptParameters(...a),
    plutusScriptHash:      (...a: unknown[]) => mockPlutusScriptHash(...a),
    verifyTxWitnesses:     (...a: unknown[]) => mockVerifyTxWitnesses(...a),
    getStatus:             (...a: unknown[]) => mockGetStatus(...a),
  };
}

jest.mock('@odatano/core', () => fullCoreMock());

import { Codes } from '../srv/core/errors';

/** Load the bridge against a core barrel that lacks some exports, then restore the full mock. */
function loadBridgeWithout(missing: string[]): typeof import('../srv/bridge') {
  let mod: typeof import('../srv/bridge') | undefined;
  try {
    jest.isolateModules(() => {
      jest.doMock('@odatano/core', () => {
        const core: Record<string, unknown> = fullCoreMock();
        for (const k of missing) delete core[k];
        return core;
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../srv/bridge');
    });
  } finally {
    jest.doMock('@odatano/core', () => fullCoreMock());
  }
  return mod!;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

// `bridge` uses a module-level init cache. We must `isolateModules` per
// test so the cache resets, otherwise an earlier successful init makes
// later "init fails" assertions impossible.
function loadBridge() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: typeof import('../srv/bridge');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../srv/bridge');
  });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return mod!;
}

beforeEach(() => {
  Object.values(mockClient).forEach(fn => fn.mockReset());
  Object.values(mockTxBuilder).forEach(fn => fn.mockReset());
  mockInitialize.mockReset();
  mockShutdown.mockReset();
  mockParseTransaction.mockReset();
  mockPosixToSlot.mockReset();
  mockSlotToPosixMs.mockReset();
  mockApplyScriptParameters.mockReset();
  mockPlutusScriptHash.mockReset();
  mockVerifyTxWitnesses.mockReset();
  mockGetStatus.mockReset();
  mockInitialize.mockResolvedValue(undefined);
  mockShutdown.mockResolvedValue(undefined);
});

describe('bridge.init / ensureInit', () => {
  it('calls @odatano/core.initialize once across concurrent callers', async () => {
    const bridge = loadBridge();
    mockClient.getProtocolParameters.mockResolvedValue({ minFeeA: 44 });

    await Promise.all([bridge.init(), bridge.init(), bridge.getProtocolParameters()]);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('translates a failing initialize into BRIDGE_UNAVAILABLE and resets the cache', async () => {
    const bridge = loadBridge();
    mockInitialize.mockRejectedValueOnce(new Error('boom'));
    await expect(bridge.init()).rejects.toThrow(/@odatano\/core init failed: boom/);

    // Second call should re-attempt init (cache cleared on failure).
    mockInitialize.mockResolvedValueOnce(undefined);
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(mockInitialize).toHaveBeenCalledTimes(2);
  });

  it('handles non-Error rejections from initialize', async () => {
    const bridge = loadBridge();
    mockInitialize.mockRejectedValueOnce('plain string');
    await expect(bridge.init()).rejects.toThrow(/@odatano\/core init failed: plain string/);
  });

  it('shutdown clears the init cache so the next call re-initialises', async () => {
    const bridge = loadBridge();
    await bridge.init();
    await bridge.shutdown();
    await bridge.init();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(mockInitialize).toHaveBeenCalledTimes(2);
  });

  it('shutdown clears the cache even when @odatano/core.shutdown throws', async () => {
    const bridge = loadBridge();
    await bridge.init();
    mockShutdown.mockRejectedValueOnce(new Error('shutdown fail'));
    await expect(bridge.shutdown()).rejects.toThrow(/shutdown fail/);

    await bridge.init();
    expect(mockInitialize).toHaveBeenCalledTimes(2);
  });
});

describe('getUtxosAtAddress', () => {
  it('throws when address is empty (no init call)', async () => {
    const bridge = loadBridge();
    await expect(bridge.getUtxosAtAddress('')).rejects.toThrow(TypeError);
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it('maps raw amount entries into lovelace + assets and propagates datum/script fields', async () => {
    const bridge = loadBridge();
    const policy   = 'a'.repeat(56);
    const assetHex = '6e616d65'; // "name"
    mockClient.getAddressUtxos.mockResolvedValue([
      {
        txHash: 'abcd', outputIndex: '3', address: 'addr_test1...',
        amount: [
          { unit: 'lovelace', quantity: '2000000' },
          { unit: `${policy}${assetHex}`, quantity: 7 },
        ],
        datumHash: 'h'.repeat(64),
        inlineDatum: 'd87980',
        scriptRef: 'scripthash',
      },
    ]);

    const out = await bridge.getUtxosAtAddress('addr_test1...');
    expect(out).toEqual([{
      txHash: 'abcd',
      outputIndex: 3,
      address: 'addr_test1...',
      lovelace: '2000000',
      assets: [{
        unit: `${policy}${assetHex}`,
        policyId: policy,
        assetNameHex: assetHex,
        quantity: '7',
      }],
      dataHash: 'h'.repeat(64),
      inlineDatumHex: 'd87980',
      referenceScriptHash: 'scripthash',
    }]);
  });

  it('defaults missing fields to safe values', async () => {
    const bridge = loadBridge();
    mockClient.getAddressUtxos.mockResolvedValue([{}]);
    const [u] = await bridge.getUtxosAtAddress('addr_test1...');
    expect(u).toMatchObject({
      txHash: '', outputIndex: 0, address: '',
      lovelace: '0', assets: [],
      dataHash: undefined, inlineDatumHex: undefined, referenceScriptHash: undefined,
    });
  });

  it('maps asset entries with missing unit / quantity defensively', async () => {
    const bridge = loadBridge();
    mockClient.getAddressUtxos.mockResolvedValue([{
      txHash: 'aa', outputIndex: 0, address: 'addr',
      amount: [
        { quantity: '500' },                  // no unit, classified as non-lovelace
        { unit: 'somepolicy.somename' },     // no quantity
      ],
    }]);
    const [u] = await bridge.getUtxosAtAddress('addr');
    // Both got mapped into the assets[] array with safe defaults.
    expect(u!.assets).toHaveLength(2);
    expect(u!.assets[0]!.unit).toBe('');
    expect(u!.assets[0]!.quantity).toBe('500');
    expect(u!.assets[1]!.quantity).toBe('0');
  });

  it('returns [] when the backend returns a non-array', async () => {
    const bridge = loadBridge();
    mockClient.getAddressUtxos.mockResolvedValue(null);
    await expect(bridge.getUtxosAtAddress('addr_test1...')).resolves.toEqual([]);
  });
});

describe('getTransactionByHash', () => {
  it('throws when txHash is empty', async () => {
    const bridge = loadBridge();
    await expect(bridge.getTransactionByHash('')).rejects.toThrow(TypeError);
  });

  it('returns the tx on success', async () => {
    const bridge = loadBridge();
    mockClient.getTransaction.mockResolvedValue({ hash: 'ab' });
    await expect(bridge.getTransactionByHash('ab'.repeat(32))).resolves.toEqual({ hash: 'ab' });
  });

  it('returns null when backend signals 404 via code', async () => {
    const bridge = loadBridge();
    mockClient.getTransaction.mockRejectedValue({ code: 404, message: 'nope' });
    await expect(bridge.getTransactionByHash('ab'.repeat(32))).resolves.toBeNull();
  });

  it('returns null when backend signals 404 via statusCode', async () => {
    const bridge = loadBridge();
    mockClient.getTransaction.mockRejectedValue({ statusCode: 404 });
    await expect(bridge.getTransactionByHash('ab'.repeat(32))).resolves.toBeNull();
  });

  it('returns null when error message matches /not.?found/i', async () => {
    const bridge = loadBridge();
    mockClient.getTransaction.mockRejectedValue(new Error('Transaction not-found on chain'));
    await expect(bridge.getTransactionByHash('ab'.repeat(32))).resolves.toBeNull();
  });

  it('re-throws non-404 errors', async () => {
    const bridge = loadBridge();
    mockClient.getTransaction.mockRejectedValue(new Error('backend 503'));
    await expect(bridge.getTransactionByHash('ab'.repeat(32))).rejects.toThrow(/backend 503/);
  });

  it('re-throws errors with no message field', async () => {
    const bridge = loadBridge();
    mockClient.getTransaction.mockRejectedValue({ code: 502 });
    await expect(bridge.getTransactionByHash('ab'.repeat(32))).rejects.toEqual({ code: 502 });
  });
});

describe('getProtocolParameters / getCurrentSlot', () => {
  it('forwards to the underlying client', async () => {
    const bridge = loadBridge();
    mockClient.getProtocolParameters.mockResolvedValue({ minFeeA: 44 });
    mockClient.getCurrentSlot.mockResolvedValue(123456);
    await expect(bridge.getProtocolParameters()).resolves.toEqual({ minFeeA: 44 });
    await expect(bridge.getCurrentSlot()).resolves.toBe(123456);
  });
});

describe('submitTransaction', () => {
  it('throws when cbor is empty', async () => {
    const bridge = loadBridge();
    await expect(bridge.submitTransaction('')).rejects.toThrow(TypeError);
  });

  it('returns the tx hash from the client', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockResolvedValue('deadbeef');
    await expect(bridge.submitTransaction('cafebabe')).resolves.toBe('deadbeef');
    expect(mockClient.submitTransaction).toHaveBeenCalledWith('cafebabe');
  });
});

describe('trySubmit', () => {
  /** An error as core's backends throw it. */
  const backendError = (statusCode: number, message = `status ${statusCode}`) =>
    Object.assign(new Error(message), { statusCode });
  /** core's error when every backend failed, carrying the single failures. */
  const allFailed = (...statusCodes: number[]) =>
    Object.assign(new Error('all backends failed'), { statusCode: 503, errors: statusCodes.map(c => backendError(c)) });

  it('is accepted when the backend takes the transaction', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockResolvedValue('ab'.repeat(32));
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'accepted' });
    expect(mockClient.submitTransaction).toHaveBeenCalledWith('cafebabe');
  });

  it('is accepted when the backend already has it (409)', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(backendError(409, 'already exists in mempool or on chain'));
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'accepted' });
  });

  it('is accepted when one of the backends already has it', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(allFailed(503, 409));
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'accepted' });
  });

  it.each([400, 422])('is rejected on a %d from the backend', async (status) => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(backendError(status, 'BadInputsUTxO'));
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'rejected', reason: 'BadInputsUTxO' });
  });

  it('is rejected when every backend rejected it', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(allFailed(400, 422));
    await expect(bridge.trySubmit('cafebabe')).resolves.toMatchObject({ kind: 'rejected' });
  });

  it.each([429, 500, 503])('is unknown on a %d from the backend', async (status) => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(backendError(status));
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'unknown', reason: `status ${status}` });
  });

  it('is unknown on a timeout or an error without a status', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(new Error('socket hang up'));
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'unknown', reason: 'socket hang up' });
    mockClient.submitTransaction.mockRejectedValue('timeout');
    await expect(bridge.trySubmit('cafebabe')).resolves.toEqual({ kind: 'unknown', reason: 'timeout' });
  });

  it('is unknown when only some backends rejected it', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(allFailed(400, 503));
    await expect(bridge.trySubmit('cafebabe')).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('is unknown when no backend was called at all', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(allFailed());
    await expect(bridge.trySubmit('cafebabe')).resolves.toMatchObject({ kind: 'unknown' });
  });

  it('cuts a long reason to 300 chars', async () => {
    const bridge = loadBridge();
    mockClient.submitTransaction.mockRejectedValue(backendError(400, 'x'.repeat(1000)));
    const r = await bridge.trySubmit('cafebabe');
    expect(r).toMatchObject({ kind: 'rejected' });
    if (r.kind === 'rejected') expect(r.reason).toHaveLength(300);
  });

  it('is unknown for an empty transaction, without calling the backend', async () => {
    const bridge = loadBridge();
    await expect(bridge.trySubmit('')).resolves.toMatchObject({ kind: 'unknown' });
    expect(mockClient.submitTransaction).not.toHaveBeenCalled();
  });
});

describe('getBackendNetwork', () => {
  it('prefixes the network core is connected to', async () => {
    const bridge = loadBridge();
    mockGetStatus.mockReturnValue({ initialized: true, network: 'preview' });
    await expect(bridge.getBackendNetwork()).resolves.toBe('cardano:preview');
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('is null when core reports no network', async () => {
    const bridge = loadBridge();
    mockGetStatus.mockReturnValue({ initialized: false });
    await expect(bridge.getBackendNetwork()).resolves.toBeNull();
  });
});

describe('createdOutputs', () => {
  const out = (outputIndex: number, isCollateral?: boolean) => ({
    address: 'addr_test1x', amount: [{ unit: 'lovelace', quantity: '1000000' }], outputIndex,
    ...(isCollateral !== undefined ? { isCollateral } : {}),
  });
  const tx = (outputs: ReturnType<typeof out>[], spendsCollaterals?: boolean) => ({
    hash: 'ab'.repeat(32), blockHeight: 1, blockTime: 1, outputs,
    ...(spendsCollaterals !== undefined ? { spendsCollaterals } : {}),
  });

  it('returns the regular outputs of a valid tx, without the collateral return', () => {
    const bridge = loadBridge();
    const created = bridge.createdOutputs(tx([out(0), out(1, false), out(2, true)]));
    expect(created.map(o => o.outputIndex)).toEqual([0, 1]);
  });

  it('treats a tx without the flag, or with it false, as valid', () => {
    const bridge = loadBridge();
    expect(bridge.createdOutputs(tx([out(0), out(1, true)], false)).map(o => o.outputIndex)).toEqual([0]);
    expect(bridge.createdOutputs(tx([out(0)])).map(o => o.outputIndex)).toEqual([0]);
  });

  it('returns only the collateral return of a failed-script tx', () => {
    const bridge = loadBridge();
    const created = bridge.createdOutputs(tx([out(0), out(1), out(2, true)], true));
    expect(created.map(o => o.outputIndex)).toEqual([2]);
  });

  it('returns nothing for a failed-script tx without a collateral return', () => {
    const bridge = loadBridge();
    expect(bridge.createdOutputs(tx([out(0)], true))).toEqual([]);
  });
});

describe('verifyTxWitnesses', () => {
  it('forwards to core', () => {
    const bridge = loadBridge();
    const result = { valid: true, txBodyHash: 'ab'.repeat(32), signerKeyHashes: ['5c'.repeat(28)], errors: [] };
    mockVerifyTxWitnesses.mockReturnValue(result);
    expect(bridge.verifyTxWitnesses('cafebabe')).toBe(result);
    expect(mockVerifyTxWitnesses).toHaveBeenCalledWith('cafebabe');
  });

  it('throws BRIDGE_UNAVAILABLE when core lacks it', () => {
    const bridge = loadBridgeWithout(['verifyTxWitnesses']);
    expect(codeOf(() => bridge.verifyTxWitnesses('cafebabe'))).toBe(Codes.BRIDGE_UNAVAILABLE);
  });
});

describe('isUtxoUnspent', () => {
  it('throws when txHash is empty', async () => {
    const bridge = loadBridge();
    await expect(bridge.isUtxoUnspent('', 0)).rejects.toThrow(TypeError);
  });

  it('throws when outputIndex is negative', async () => {
    const bridge = loadBridge();
    await expect(bridge.isUtxoUnspent('ab'.repeat(32), -1)).rejects.toThrow(TypeError);
  });

  it('throws when outputIndex is not an integer', async () => {
    const bridge = loadBridge();
    await expect(bridge.isUtxoUnspent('ab'.repeat(32), 1.5)).rejects.toThrow(TypeError);
  });

  it('forwards a valid call to the client', async () => {
    const bridge = loadBridge();
    mockClient.isUtxoUnspent.mockResolvedValue(true);
    await expect(bridge.isUtxoUnspent('ab'.repeat(32), 0)).resolves.toBe(true);
    expect(mockClient.isUtxoUnspent).toHaveBeenCalledWith('ab'.repeat(32), 0);
  });
});

describe('parseTransaction', () => {
  it('forwards to @odatano/core and returns the parsed shape', () => {
    const bridge = loadBridge();
    const parsed = { txHash: 'ab'.repeat(32), inputs: [], outputs: [] };
    mockParseTransaction.mockReturnValue(parsed);
    expect(bridge.parseTransaction('cafe')).toBe(parsed);
    expect(mockParseTransaction).toHaveBeenCalledWith('cafe');
  });

  it('wraps a core parse failure as X402Error(INVALID_CBOR)', () => {
    const bridge = loadBridge();
    mockParseTransaction.mockImplementation(() => { throw new Error('bad cbor'); });
    try {
      bridge.parseTransaction('deadbeef');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe(Codes.INVALID_CBOR);
      expect((e as Error).message).toMatch(/bad cbor/);
    }
  });

  it('throws BRIDGE_UNAVAILABLE when core does not export parseTransaction', () => {
    // Re-mock the core barrel without parseTransaction for this module load,
    // then restore the standard mock so later tests see getCardanoTxBuilder.
    try {
      jest.isolateModules(() => {
        jest.doMock('@odatano/core', () => ({
          initialize:       (...a: unknown[]) => mockInitialize(...a),
          shutdown:         (...a: unknown[]) => mockShutdown(...a),
          getCardanoClient: () => mockClient,
          // no parseTransaction / getCardanoTxBuilder
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const bridge = require('../srv/bridge') as typeof import('../srv/bridge');
        try {
          bridge.parseTransaction('cafe');
          throw new Error('expected throw');
        } catch (e) {
          expect((e as { code?: string }).code).toBe(Codes.BRIDGE_UNAVAILABLE);
        }
      });
    } finally {
      jest.doMock('@odatano/core', () => fullCoreMock());
    }
  });
});

describe('buildUnsignedTransfer', () => {
  const baseReq = {
    senderAddress:    'addr_test1buyer',
    recipientAddress: 'addr_test1seller',
    lovelaceAmount:   '2000000',
  };

  it('routes a pure-ADA request to buildSimpleAdaTransaction', async () => {
    const bridge = loadBridge();
    mockClient.getProtocolParameters.mockResolvedValue({ minFeeA: 44 });
    mockTxBuilder.buildSimpleAdaTransaction.mockResolvedValue({ unsignedTxCbor: 'aa' });

    const r = await bridge.buildUnsignedTransfer(baseReq);
    expect(r).toEqual({ unsignedTxCbor: 'aa' });
    expect(mockTxBuilder.buildSimpleAdaTransaction).toHaveBeenCalledWith(baseReq, { minFeeA: 44 });
    expect(mockTxBuilder.buildMultiAssetTransaction).not.toHaveBeenCalled();
  });

  it('routes a request with assets to buildMultiAssetTransaction', async () => {
    const bridge = loadBridge();
    const req = { ...baseReq, assets: [{ unit: 'a'.repeat(56) + '4242', quantity: '10' }] };
    mockClient.getProtocolParameters.mockResolvedValue({ minFeeA: 44 });
    mockTxBuilder.buildMultiAssetTransaction.mockResolvedValue({ unsignedTxCbor: 'bb' });

    const r = await bridge.buildUnsignedTransfer(req);
    expect(r).toEqual({ unsignedTxCbor: 'bb' });
    expect(mockTxBuilder.buildMultiAssetTransaction).toHaveBeenCalledWith(req, { minFeeA: 44 });
    expect(mockTxBuilder.buildSimpleAdaTransaction).not.toHaveBeenCalled();
  });

  it('treats an empty assets array as pure-ADA', async () => {
    const bridge = loadBridge();
    const req = { ...baseReq, assets: [] };
    mockClient.getProtocolParameters.mockResolvedValue({});
    mockTxBuilder.buildSimpleAdaTransaction.mockResolvedValue({ unsignedTxCbor: 'cc' });

    await bridge.buildUnsignedTransfer(req);
    expect(mockTxBuilder.buildSimpleAdaTransaction).toHaveBeenCalled();
    expect(mockTxBuilder.buildMultiAssetTransaction).not.toHaveBeenCalled();
  });
});

describe('getFeeParameters', () => {
  it('maps the fee and min-UTxO parameters to bigint', async () => {
    const bridge = loadBridge();
    mockClient.getProtocolParameters.mockResolvedValue({ minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: '4310' });
    await expect(bridge.getFeeParameters()).resolves.toEqual({
      minFeeA: 44n, minFeeB: 155381n, coinsPerUtxoByte: 4310n,
    });
  });

  it('reports a missing coinsPerUtxoSize as null', async () => {
    const bridge = loadBridge();
    mockClient.getProtocolParameters.mockResolvedValue({ minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: null });
    expect((await bridge.getFeeParameters()).coinsPerUtxoByte).toBeNull();
  });
});

describe('getTipHeight', () => {
  it('returns the tip block height', async () => {
    const bridge = loadBridge();
    mockClient.getLatestBlock.mockResolvedValue({ height: 4730334 });
    await expect(bridge.getTipHeight()).resolves.toBe(4730334);
  });

  it('throws BRIDGE_UNAVAILABLE when the backend reports no height', async () => {
    const bridge = loadBridge();
    mockClient.getLatestBlock.mockResolvedValue({ height: null });
    await expect(bridge.getTipHeight()).rejects.toMatchObject({ code: Codes.BRIDGE_UNAVAILABLE });
  });
});

describe('posixToSlot / slotToPosixMs', () => {
  it('passes the network without the cardano: prefix', () => {
    const bridge = loadBridge();
    mockPosixToSlot.mockReturnValue(123);
    mockSlotToPosixMs.mockReturnValue(456);
    expect(bridge.posixToSlot('cardano:preview', 1_700_000_000_000)).toBe(123);
    expect(mockPosixToSlot).toHaveBeenCalledWith('preview', 1_700_000_000_000);
    expect(bridge.slotToPosixMs('cardano:mainnet', 99)).toBe(456);
    expect(mockSlotToPosixMs).toHaveBeenCalledWith('mainnet', 99);
  });

  it('throws BRIDGE_UNAVAILABLE when core lacks them', () => {
    const bridge = loadBridgeWithout(['posixToSlot', 'slotToPosixMs']);
    expect(codeOf(() => bridge.posixToSlot('cardano:preview', 0))).toBe(Codes.BRIDGE_UNAVAILABLE);
    expect(codeOf(() => bridge.slotToPosixMs('cardano:preview', 0))).toBe(Codes.BRIDGE_UNAVAILABLE);
  });
});

describe('applyScriptParameters / plutusScriptHash', () => {
  it('forward to core', () => {
    const bridge = loadBridge();
    mockApplyScriptParameters.mockReturnValue('ccdd');
    mockPlutusScriptHash.mockReturnValue('5c'.repeat(28));
    expect(bridge.applyScriptParameters('aabb', [{ int: '42' }])).toBe('ccdd');
    expect(mockApplyScriptParameters).toHaveBeenCalledWith('aabb', [{ int: '42' }]);
    expect(bridge.plutusScriptHash('ccdd', 'plutusV3')).toBe('5c'.repeat(28));
  });

  it('throw BRIDGE_UNAVAILABLE when core lacks them', () => {
    const bridge = loadBridgeWithout(['applyScriptParameters', 'plutusScriptHash']);
    expect(codeOf(() => bridge.applyScriptParameters('aabb', []))).toBe(Codes.BRIDGE_UNAVAILABLE);
    expect(codeOf(() => bridge.plutusScriptHash('aabb', 'plutusV3'))).toBe(Codes.BRIDGE_UNAVAILABLE);
  });
});
