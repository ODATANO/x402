/**
 * Shared test wiring for @odatano/core's pure `parseTransaction`.
 *
 * srv/bridge.ts does a top-level `require('@odatano/core')`, whose full
 * barrel drags in uncompiled `@cds-models/*.ts` (via cardano-indexer)
 * that ts-jest won't transform. Suites that import `decode` (which needs
 * the real parser) stub the barrel down to core's pure `cbor/parse`
 * module — deps: buildooor + pure error classes only — via `coreParseMock`.
 *
 * Suites that mock `srv/bridge` wholesale instead (bridgeFactory) and call
 * decode through verifyPayment wire `realParseTransaction` onto the mocked
 * `bridge.parseTransaction` after their `resetAllMocks()`.
 */

/** core's real, pure witness check. */
export function realVerifyTxWitnesses(signedTxCbor: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifyTxWitnesses } = jest.requireActual('@odatano/core/srv/blockchain/signing/signature-verifier');
  return verifyTxWitnesses(signedTxCbor);
}

/** Witness check result for a tx signed by the test buyer key. */
export function buyerSignedWitnesses() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BUYER_VKH } = jest.requireActual('./constants');
  return { valid: true, txBodyHash: null, signerKeyHashes: [BUYER_VKH as string], errors: [] as string[] };
}

/**
 * Drop-in replacement for the `@odatano/core` barrel exposing parse plus
 * the pure script and witness helpers as mocks.
 */
export function coreParseMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseTransaction } = jest.requireActual('@odatano/core/srv/cbor/parse');
  return {
    parseTransaction,
    initialize: jest.fn(),
    shutdown: jest.fn(),
    getCardanoClient: jest.fn(),
    getCardanoTxBuilder: jest.fn(),
    applyScriptParameters: jest.fn(),
    plutusScriptHash: jest.fn(),
    verifyTxWitnesses: jest.fn(realVerifyTxWitnesses),
  };
}

/** Real (Buildooor) parse with the same X402Error wrapping bridge.ts applies. */
export function realParseTransaction(cborHex: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { parseTransaction } = jest.requireActual('@odatano/core/srv/cbor/parse');
  try {
    return parseTransaction(cborHex);
  } catch (e) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { X402Error, Codes } = jest.requireActual('../../srv/core/errors');
    throw new X402Error(Codes.INVALID_CBOR, String((e as Error)?.message ?? e));
  }
}
