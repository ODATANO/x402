/**
 * Smoke test for the public barrel: every value export resolves, and the
 * names removed in 0.7.0 are gone.
 *
 * Bridge is mocked because importing it triggers `require('@odatano/core')`.
 */

import { bridgeFactory } from './fixtures/mock-bridge';
jest.mock('../srv/bridge', () => bridgeFactory());

import * as x402 from '../srv/index';

const FUNCTIONS = [
  // core
  'buildRequirements', 'buildPaymentRequired', 'normalizeResource', 'parsePaymentPayload',
  'decodePayment', 'findAcceptedRequirements', 'validatePayment', 'matchOutput', 'buildClaim',
  'transferMethodOf', 'isScriptExtra',
  'parseAsset', 'buildAssetString', 'parseNetwork', 'normalizeNetwork', 'isNetwork', 'networksMatch',
  'X402Error',
  // facilitator
  'localFacilitator', 'defaultFacilitator', 'httpFacilitator', 'createFacilitatorRouter',
  'memorySettlementStore', 'cdsSettlementStore', 'memoryIssuedRequirementsStore',
  // helpers, middleware
  'verifyConfirmedPayment', 'buildUnsignedPaymentTx', 'x402Middleware', 'gateService',
  // client
  'x402Fetch', 'x402Axios', 'encodePaymentPayload', 'readPaymentRequired', 'readSettlement',
  'isSettlementPending', 'selectFirstSupported', 'createBridgePayHandler',
  'X402PaymentError', 'parseErrorCode', 'paymentErrorFrom',
] as const;

const REMOVED = [
  'buildEntry', 'buildPaymentRequirements', 'buildPaymentRequirementsMulti', 'flatRequirements',
  'decode', 'encodePaymentEnvelope', 'verifyPayment', 'settle', 'checkNonceUnspent',
  'checkTransfer', 'paymentErrorFromBody', 'resolveSettlementsEntity',
];

describe('@odatano/x402 public barrel', () => {
  it.each(FUNCTIONS)('exports %s', (name) => {
    expect(typeof (x402 as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports the constants', () => {
    expect(x402.Codes.PENDING).toBe('settlement_pending');
    expect(x402.SUPPORTED_TRANSFER_METHODS).toEqual(['default', 'script']);
    expect(x402.DEFAULT_SETTLEMENTS_ENTITY).toBe('odatano.x402.X402Settlements');
  });

  it.each(REMOVED)('no longer exports %s', (name) => {
    expect((x402 as Record<string, unknown>)[name]).toBeUndefined();
  });

  it('exposes the bridge namespace', () => {
    expect(typeof x402.bridge.init).toBe('function');
    expect(typeof x402.bridge.posixToSlot).toBe('function');
    expect(typeof x402.bridge.trySubmit).toBe('function');
  });

  it('hands out one default facilitator per process', () => {
    expect(x402.defaultFacilitator()).toBe(x402.defaultFacilitator());
    expect(x402.localFacilitator()).not.toBe(x402.defaultFacilitator());
  });
});
