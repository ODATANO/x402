/**
 * Smoke test for the public barrel. Every export listed in srv/index.ts
 * must resolve to a defined value (functions / classes / namespaces),
 * which catches accidental renames or missing re-exports during refactors.
 *
 * Bridge is mocked because importing it triggers `require('@odatano/core')`
 * which spins up a real client at module load time.
 */

import { bridgeFactory } from './fixtures/mock-bridge';
jest.mock('../srv/bridge', () => bridgeFactory());

import * as x402 from '../srv/index';

describe('@odatano/x402 public barrel', () => {
  it('exposes the core builders / validators', () => {
    expect(typeof x402.buildPaymentRequirements).toBe('function');
    expect(typeof x402.buildEntry).toBe('function');
    expect(typeof x402.flatRequirements).toBe('function');
    expect(typeof x402.decode).toBe('function');
    expect(typeof x402.validatePayment).toBe('function');
  });

  it('exposes the asset / network helpers', () => {
    expect(typeof x402.parseAsset).toBe('function');
    expect(typeof x402.buildAssetString).toBe('function');
    expect(typeof x402.parseNetwork).toBe('function');
    expect(typeof x402.isNetwork).toBe('function');
    expect(typeof x402.networksMatch).toBe('function');
  });

  it('exposes errors / codes', () => {
    expect(typeof x402.X402Error).toBe('function');
    expect(x402.Codes).toBeDefined();
    expect(x402.Codes.MISSING_HEADER).toBeDefined();
  });

  it('exposes the facilitator surface', () => {
    expect(typeof x402.verifyPayment).toBe('function');
    expect(typeof x402.settle).toBe('function');
    expect(typeof x402.checkNonceUnspent).toBe('function');
    expect(typeof x402.localFacilitator).toBe('function');
    expect(typeof x402.httpFacilitator).toBe('function');
    expect(typeof x402.createFacilitatorRouter).toBe('function');
  });

  it('exposes helpers, middleware, and client', () => {
    expect(typeof x402.verifyConfirmedPayment).toBe('function');
    expect(typeof x402.buildUnsignedPaymentTx).toBe('function');
    expect(typeof x402.x402Middleware).toBe('function');
    expect(typeof x402.gateService).toBe('function');
    expect(typeof x402.x402Fetch).toBe('function');
    expect(typeof x402.x402Axios).toBe('function');
    expect(typeof x402.encodePaymentEnvelope).toBe('function');
    expect(typeof x402.createBridgePayHandler).toBe('function');
    expect(typeof x402.X402PaymentError).toBe('function');
    expect(typeof x402.parseErrorCode).toBe('function');
    expect(typeof x402.paymentErrorFromBody).toBe('function');
  });

  it('exposes the bridge namespace', () => {
    expect(x402.bridge).toBeDefined();
    expect(typeof x402.bridge.init).toBe('function');
  });
});
