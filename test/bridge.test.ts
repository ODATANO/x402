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
};
const mockInitialize    = jest.fn();
const mockShutdown      = jest.fn();
const mockParseTransaction = jest.fn();

jest.mock('@odatano/core', () => ({
  initialize:       (...a: unknown[]) => mockInitialize(...a),
  shutdown:         (...a: unknown[]) => mockShutdown(...a),
  getCardanoClient: () => mockClient,
  parseTransaction: (...a: unknown[]) => mockParseTransaction(...a),
}));

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
  mockInitialize.mockReset();
  mockShutdown.mockReset();
  mockParseTransaction.mockReset();
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

describe('parseTransaction re-export', () => {
  it('is defined when @odatano/core exports it', () => {
    const bridge = loadBridge();
    expect(typeof bridge.parseTransaction).toBe('function');
  });
});
