/**
 * Public type surface for x402 Cardano-v2.
 *
 * The shapes here match the Cardano-x402-v2 spec (envelope, requirements,
 * payload). See `docs/protocol.md` for the wire-level reference. Keep
 * this file as the single source of truth: middleware, facilitator and
 * helpers all import from here.
 */

import type { Network } from './network';

/** Asset-transfer method. v2 spec. This library handles `default` and `script`. */
export type AssetTransferMethod = 'default' | 'masumi' | 'script';

/** Plutus script inlined in a `script` transfer. */
export interface TransferScript {
  type: 'plutusV1' | 'plutusV2' | 'plutusV3';
  /** CBOR hex of the compiled script. */
  code: string;
}

/** One parameter applied to a `script` transfer's script. */
export interface TransferScriptParameter {
  type: 'bytes' | 'bigint' | 'integer' | 'string' | 'constr' | 'list' | 'map' | 'boolean';
  /** Encoding depends on `type`. */
  value: unknown;
}

/** `extra` of an address-to-address payment. */
export interface DefaultTransferExtra {
  [key: string]: unknown;
  assetTransferMethod?: 'default';
}

/**
 * `extra` of a payment that locks funds at a script address. `payTo` must be
 * the address of the script named by `scriptHash`, or by `script` plus
 * `parameters`.
 */
export interface ScriptTransferExtra {
  [key: string]: unknown;
  assetTransferMethod: 'script';
  /** 56 hex chars. */
  scriptHash?: string;
  script?: TransferScript;
  parameters?: Record<string, TransferScriptParameter>;
  /** CBOR hex; inline datum the buyer attaches to the `payTo` output. */
  datum?: string;
}

/** `accepts[].extra`. `assetTransferMethod` selects the shape, absent means `default`. */
export type PaymentExtra = DefaultTransferExtra | ScriptTransferExtra;

/** v2 resource descriptor, was a bare string in v1. */
export interface ResourceDescriptor {
  url: string;
  description: string;
  mimeType: string;
  /** Optional, free-form JSON Schema for the resource's response body. */
  outputSchema?: unknown;
}

/** A single `accepts[]` entry of the 402 body. */
export interface PaymentRequirementEntry {
  scheme: 'exact';
  network: Network;
  /**
   * v2 asset format: `<policyIdHex>.<assetNameHex>` (dot-separated) OR
   * the literal `'lovelace'` for ADA payments.
   */
  asset: string;
  /** Required asset amount in raw units (BigInt-safe string). */
  amount: string;
  /** Bech32 recipient. */
  payTo: string;
  resource: ResourceDescriptor;
  maxTimeoutSeconds: number;
  /** Transfer method plus free-form fields (e.g. UI hints, decimals). */
  extra?: PaymentExtra;
}

/** Canonical 402-response body. */
export interface PaymentRequirementsBody {
  x402Version: 2;
  error?: string;
  accepts: PaymentRequirementEntry[];
}

/**
 * Decoded `PAYMENT-SIGNATURE` envelope. The envelope payload references
 * a buyer-funded UTxO (the **nonce**) which must also appear in the
 * payment tx's inputs, this is the v2 replay defense, on-chain.
 */
export interface PaymentEnvelope {
  x402Version: 2;
  scheme: 'exact';
  network: string;
  payload: {
    /** base64 CBOR of the signed payment tx */
    transaction: string;
    /** `<txHash>#<outputIndex>`, UTxO acting as replay nonce */
    nonce: string;
  };
}

/** Result of pure validation (no chain calls). */
export interface PaymentClaim {
  /** Hash of the buyer's signed payment tx (lowercase hex, 64 chars). */
  txHash: string;
  /** Amount actually paid to `payTo` for `asset`, summed across outputs. */
  amountUnits: string;
  network: Network;
  /** Resolved v2 unit key (`policyId+nameHex` or empty for lovelace). */
  unit: string;
  /** The v2 asset string from requirements (passed-through for audit). */
  asset: string;
  /** Bech32 recipient the matched requirements entry credited. */
  payTo: string;
  /** The route / resource URL the buyer paid for. */
  resourceUrl: string;
  /** UTxO-ref nonce as `<txHash>#<index>`. */
  nonceRef: string;
  /**
   * Bech32 address of the nonce UTxO, i.e. the buyer's own input, proven by
   * the signature that spent it. Filled by the facilitator (one
   * `getTransactionByHash` on the nonce's tx); unset when the backend could
   * not resolve it. The one payer identity a resource server may bind to.
   */
  payerAddr?: string;
  /** Set for `script` transfers. */
  extra?: ScriptClaimExtra;
}

export interface ScriptClaimExtra {
  assetTransferMethod: 'script';
  /** `<txHash>#<outputIndex>` of every output paying `payTo`, i.e. the locked UTxOs. */
  lockRefs: string[];
}

/** Diagnostic shape returned by `decode()` for downstream validation. */
export interface DecodedPayment {
  envelope: PaymentEnvelope;
  /** Hex of the signed-tx CBOR (preserved bytes, NOT a re-encode). */
  txCborHex: string;
  /** Hash of the tx body, lowercase 64-char hex. */
  txHash: string;
  outputs: DecodedOutput[];
  inputs: DecodedInput[];
  vkeyWitnessCount: number;
  /** Validity-range upper bound in slots (`null` ⇒ no TTL set). */
  ttlSlot: number | null;
  /** Validity-range lower bound in slots (`null` ⇒ no lower bound set). */
  validityStartSlot: number | null;
  /** Parsed nonce reference. */
  nonce: { txHash: string; index: number };
}

export interface DecodedOutput {
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: DecodedAsset[];
  /** CBOR hex; null = no inline datum. */
  inlineDatumHex: string | null;
}

export interface DecodedAsset {
  unit: string;          // policyId + assetNameHex, lowercase
  policyId: string;      // lowercase hex
  assetNameHex: string;  // lowercase hex
  quantity: string;
}

export interface DecodedInput {
  txHash: string;
  outputIndex: number;
}

export type { Network };

// ─── Pricing surface (multi-accept + resolver) ────────────────────────────

/**
 * One payment option inside a multi-accept route. Lets a seller advertise
 * e.g. "0.5 ADA or 0.1 USDM" for the same route. Top-level middleware
 * options (`payTo`, `network`, `asset`, `description`, ...) fill any
 * field the option leaves unset.
 *
 * The buyer's tx picks ONE option implicitly by which (payTo, asset) it
 * actually pays; the facilitator selects the matching entry via
 * `pickRequirement()` before running the six validation checks against it.
 */
export interface RouteOption {
  amount: string | number | bigint;
  asset?: string;
  payTo?: string;
  network?: Network | string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: PaymentExtra;
}

/**
 * What a `routePricing` entry or a `PriceResolver` may return.
 *
 *   - scalar             , single price in the route's default asset
 *   - `RouteOption`      , single option with field overrides
 *   - `RouteOption[]`    , multi-accept, buyer picks one on-chain
 *
 * Returning `null` from a resolver means "no gate, pass through" , the
 * non-null type is what gates a request.
 */
export type PriceSpec =
  | string
  | number
  | bigint
  | RouteOption
  | RouteOption[];

/**
 * Context passed to a `PriceResolver`. Intentionally minimal so we don't
 * leak express/CAP-specific shapes through the public API. Both
 * middlewares fill the common fields; CAP-only fields are optional.
 */
export interface PricingContext {
  /**
   * CAP: req.event ('READ'|'CREATE'|action-name).
   * Express: last URL segment with OData function args stripped.
   */
  event: string;
  /** CAP target name (e.g. 'PricesService.Quotes'). Undefined in Express. */
  target?: string;
  /** Express request path. Undefined in CAP. */
  path?: string;
  /** HTTP method. Express only. */
  method?: string;
  /** Lower-cased header map. Array values for multi-valued headers. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed query params (Express). */
  query?: Record<string, string | string[] | undefined>;
}

/**
 * Dynamic pricing function. Sync or async. Return `null` to skip the
 * gate, a scalar / option / option-array to charge. Errors thrown here
 * are treated as middleware failures and surface as 500 to the buyer.
 */
export type PriceResolver = (ctx: PricingContext) => PriceSpec | null | Promise<PriceSpec | null>;
