/**
 * Explicit factory for `jest.mock('.../srv/bridge', ...)`.
 *
 * Why explicit (not auto-mock): srv/bridge.ts has a top-level
 * `require('@odatano/core')` whose target package contains source .ts
 * files. Jest's auto-mock loads the original module to derive its
 * surface, which then drags in those .ts files, and ts-jest's default
 * `transformIgnorePatterns` skips node_modules, so they fail to parse.
 *
 * The factory below returns a jest.fn() per known export. Tests then
 * cast back to `jest.Mocked<typeof bridge>` and drive each method.
 */

export function bridgeFactory() {
  return {
    init: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    getUtxosAtAddress: jest.fn(),
    getTransactionByHash: jest.fn(),
    getProtocolParameters: jest.fn(),
    submitTransaction: jest.fn(),
    getCurrentSlot: jest.fn(),
    isUtxoUnspent: jest.fn(),
    parseTransaction: jest.fn(),
  };
}
