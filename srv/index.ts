/**
 * @odatano/x402, public API barrel.
 *
 * x402 v2 with the Cardano `exact` scheme, for SAP CAP and Express.
 *
 *   // 1. Express middleware (mount under a path)
 *   import { x402Middleware } from '@odatano/x402';
 *   app.use('/api/premium', x402Middleware({
 *     payTo: 'addr_test1...', network: 'cardano:preprod', asset: 'lovelace',
 *     priceUnits: '1000000',
 *   }));
 *
 *   // 2. CAP service gate
 *   import { gateService } from '@odatano/x402';
 *   class MyService extends cds.ApplicationService {
 *     async init() {
 *       gateService(this, { payTo, network, asset, routePricing: { Prices: '1000000' } });
 *       return super.init();
 *     }
 *   }
 *
 *   // 3. Client: fetch that pays 402s
 *   import { x402Fetch, createBridgePayHandler } from '@odatano/x402';
 *   const paidFetch = x402Fetch({ pay: createBridgePayHandler({ buyerBech32, signTx }) });
 */

// ─── Core builders / validators (pure) ────────────────────────────────
export {
  buildRequirements,
  buildPaymentRequired,
  normalizeResource,
  type BuildRequirementsArgs,
  type BuildPaymentRequiredArgs,
} from './core/requirements';
export { parsePaymentPayload } from './core/payload';
export { decodePayment } from './core/decode';
export { findAcceptedRequirements } from './core/match';
export {
  validatePayment,
  matchOutput,
  buildClaim,
  type ValidationResult,
  type ValidateOptions,
  type PaymentMatch,
} from './core/validate';
export {
  SUPPORTED_TRANSFER_METHODS,
  transferMethodOf,
  isScriptExtra,
} from './core/transfer-method';

// ─── Asset / network helpers ──────────────────────────────────────────
export { parseAsset, buildAssetString, type ParsedAsset } from './core/asset';
export { parseNetwork, normalizeNetwork, isNetwork, networksMatch, type Network } from './core/network';

// ─── Errors / codes ───────────────────────────────────────────────────
export { X402Error, Codes, type X402Code } from './core/errors';

// ─── Types ────────────────────────────────────────────────────────────
export type {
  AssetTransferMethod,
  ConfirmationPolicy,
  TransferScript,
  TransferScriptParameter,
  DefaultTransferExtra,
  ScriptTransferExtra,
  PaymentExtra,
  ResourceInfo,
  PaymentRequirements,
  PaymentRequired,
  PaymentPayload,
  CardanoExactPayload,
  SettlementResponse,
  SettlementEvidence,
  VerifyResponse,
  Extensions,
  PaymentClaim,
  ScriptClaimExtra,
  DecodedPayment,
  DecodedOutput,
  DecodedAsset,
  DecodedInput,
  RouteOption,
  PriceSpec,
  PriceResolver,
  PricingContext,
} from './core/types';

// ─── Facilitator ──────────────────────────────────────────────────────
export {
  localFacilitator,
  defaultFacilitator,
  type Facilitator,
  type LocalFacilitatorOptions,
  type SupportedKind,
  type SupportedResponse,
} from './facilitator/adapter';
export { httpFacilitator, type HttpFacilitatorConfig } from './facilitator/http';
export {
  createFacilitatorRouter,
  type CreateFacilitatorRouterOptions,
  type FacilitatorServerLogger,
} from './facilitator/server';
export {
  memorySettlementStore,
  type SettlementStore,
  type SettlementRecord,
  type SettlementState,
  type ClaimResult,
} from './facilitator/store';
export { cdsSettlementStore, DEFAULT_SETTLEMENTS_ENTITY } from './facilitator/cds-store';

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
export {
  memoryIssuedRequirementsStore,
  type IssuedRequirementsStore,
} from './middleware/issued';
export {
  type PaymentGateOptions,
  type VerifyTransfer,
  type TransferCheckContext,
  type TransferCheckResult,
} from './middleware/flow';

// ─── Client (HTTP wrappers that pay 402s) ─────────────────────────────
export { x402Fetch, type X402FetchOptions } from './client/fetch';
export { x402Axios } from './client/axios';
export {
  encodePaymentPayload,
  readPaymentRequired,
  readSettlement,
  isSettlementPending,
  type EncodePaymentPayloadArgs,
} from './client/protocol';
export { selectFirstSupported } from './client/select';
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
export {
  X402PaymentError,
  parseErrorCode,
  paymentErrorFrom,
  type X402PaymentErrorKind,
  type X402PaymentErrorInit,
} from './client/errors';

// ─── Bridge (lower-level: exposed for advanced consumers) ─────────────
export * as bridge from './bridge';
