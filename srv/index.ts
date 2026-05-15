/**
 * @odatano/x402 — public API barrel.
 *
 * Cardano-x402-v2 payment library for SAP CAP applications.
 *
 * Three usage shapes:
 *
 *   // 1. Express middleware (mount under a path)
 *   import { x402Middleware } from '@odatano/x402';
 *   app.use('/api/premium', x402Middleware({
 *     payTo: 'addr_test1...',
 *     network: 'cardano:preprod',
 *     asset: '16a55b...ddde.0014df105553444d',
 *     priceUnits: '1000000',
 *     onAccepted: async (claim) => { ... },
 *   }));
 *
 *   // 2. CAP service gate (registers a before-* handler)
 *   import { gateService } from '@odatano/x402';
 *   class MyService extends cds.ApplicationService {
 *     async init() {
 *       gateService(this, {
 *         payTo, network, asset,
 *         routePricing: { Prices: '10000', getBestPrice: '10000' },
 *       });
 *       return super.init();
 *     }
 *   }
 *
 *   // 3. Programmatic — verify a confirmed payment by tx hash
 *   import { verifyConfirmedPayment } from '@odatano/x402';
 *   const r = await verifyConfirmedPayment({
 *     txHash, requiredAmount, asset, payTo, network,
 *   });
 */

// ─── Core builders / validators (pure) ────────────────────────────────
export {
  buildPaymentRequirements,
  buildEntry,
  flatRequirements,
  type BuildPaymentRequirementsArgs,
} from './core/requirements';

export { decode } from './core/decode';
export { validatePayment, type ValidationResult, type ValidateOptions } from './core/validate';

// ─── Asset / network helpers ──────────────────────────────────────────
export { parseAsset, buildAssetString, type ParsedAsset } from './core/asset';
export { parseNetwork, isNetwork, networksMatch, type Network } from './core/network';

// ─── Errors / codes ───────────────────────────────────────────────────
export { X402Error, Codes, type X402Code } from './core/errors';

// ─── Types ────────────────────────────────────────────────────────────
export type {
  AssetTransferMethod,
  ResourceDescriptor,
  PaymentRequirementEntry,
  PaymentRequirementsBody,
  PaymentEnvelope,
  PaymentClaim,
  DecodedPayment,
  DecodedOutput,
  DecodedAsset,
  DecodedInput,
} from './core/types';

// ─── Facilitator (chain-touching) ─────────────────────────────────────
export {
  process as verifyPayment,
  type ProcessArgs,
  type ProcessResult,
  type ProcessKind,
} from './facilitator/verify';
export { settle, type SettleArgs, type SettleResult } from './facilitator/settle';
export { checkNonceUnspent, type NonceCheckArgs, type NonceResult } from './facilitator/nonce';

// ─── Facilitator adapter (pluggable local vs hosted) ──────────────────
export {
  localFacilitator,
  type Facilitator,
  type FacilitatorVerifyAndSettleArgs,
  type FacilitatorResult,
  type FacilitatorSupportedResult,
} from './facilitator/adapter';
export {
  httpFacilitator,
  type HttpFacilitatorConfig,
} from './facilitator/http';

// ─── Helpers ──────────────────────────────────────────────────────────
export {
  verifyConfirmedPayment,
  type VerifyConfirmedArgs,
  type VerifyConfirmedResult,
} from './helpers/verify-confirmed';

export {
  buildUnsignedPaymentTx,
  type BuildUnsignedTxArgs,
  type UnsignedTxResult,
} from './helpers/build-unsigned-tx';

// ─── Middleware ───────────────────────────────────────────────────────
export { x402Middleware, type X402MiddlewareOptions } from './middleware/express';
export { gateService, type X402CapOptions } from './middleware/cap';

// ─── Client (HTTP wrappers that auto-handle 402) ──────────────────────
export { x402Fetch, type X402FetchOptions } from './client/fetch';
export { x402Axios } from './client/axios';
export {
  encodePaymentEnvelope,
  type EncodeEnvelopeArgs,
} from './client/envelope';
export {
  createBridgePayHandler,
  type BridgePayHandlerOptions,
} from './client/pay-handlers';
export type {
  PayHandler,
  PayHandlerResult,
  AcceptsSelector,
  X402ClientOptions,
} from './client/types';

// ─── Bridge (lower-level: exposed for advanced consumers) ─────────────
export * as bridge from './bridge';
