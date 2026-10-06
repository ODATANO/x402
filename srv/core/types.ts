/**
 * Public type surface of x402 v2 with the Cardano `exact` scheme.
 *
 * Names and shapes follow the x402 v2 specification (`PaymentRequired`,
 * `PaymentRequirements`, `PaymentPayload`, `SettlementResponse`,
 * `VerifyResponse`). See `docs/protocol.md` for the wire reference.
 */

import type { Network } from './network';

/** Asset-transfer method of Cardano `exact`. This library handles `default` and `script`. */
export type AssetTransferMethod = 'default' | 'masumi' | 'script';

/**
 * Minimum L1 evidence before the resource is released: -1 = broadcast
 * accepted by the facilitator's node, 0 = in a block, n = n newer blocks.
 */
export interface ConfirmationPolicy {
  /** integer -1..20; default 1 */
  l1Confirmations: number;
}

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

/** `extra` keys every Cardano method shares. */
interface CardanoExtraBase {
  [key: string]: unknown;
  confirmationPolicy?: ConfirmationPolicy;
  /** Always false on Cardano: the buyer pays the network fee. */
  areFeesSponsored?: boolean;
  /** Payment flow; Cardano `exact` only defines `authorization`. */
  paymentFlow?: string;
}

/** `extra` of an address-to-address payment. */
export interface DefaultTransferExtra extends CardanoExtraBase {
  assetTransferMethod?: 'default';
}

/**
 * `extra` of a payment that locks funds at a script address. `payTo` must be
 * the address of the script named by `scriptHash`, or by `script` plus
 * `parameters`.
 */
export interface ScriptTransferExtra extends CardanoExtraBase {
  assetTransferMethod: 'script';
  /** 56 hex chars. */
  scriptHash?: string;
  script?: TransferScript;
  parameters?: Record<string, TransferScriptParameter>;
  /** CBOR hex; inline datum the buyer attaches to the `payTo` output. */
  datum?: string;
}

/** `PaymentRequirements.extra`. `assetTransferMethod` selects the shape, absent means `default`. */
export type PaymentExtra = DefaultTransferExtra | ScriptTransferExtra;

/** The protected resource, once per `PaymentRequired`. */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  /** Printable ASCII, max 32 chars. */
  serviceName?: string;
  /** Max 5 entries, each printable ASCII, max 32 chars. */
  tags?: string[];
  /** Absolute http(s) URL, max 2048 chars. */
  iconUrl?: string;
}

/** One `accepts[]` entry: a way to pay for the resource. */
export interface PaymentRequirements {
  scheme: 'exact';
  network: Network;
  /** `'lovelace'` or `<policyIdHex>.<assetNameHex>`. */
  asset: string;
  /** Atomic units, decimal string. */
  amount: string;
  /** Bech32 recipient. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: PaymentExtra;
}

/** Protocol extensions, keyed by extension name. */
export type Extensions = Record<string, unknown>;

/** Content of the `PAYMENT-REQUIRED` header. */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Extensions;
}

/** Scheme payload of Cardano `exact`. */
export interface CardanoExactPayload {
  /** Base64 CBOR of the signed, unbroadcast transaction. */
  transaction: string;
  /** `<txHash>#<outputIndex>` of a buyer UTxO the transaction spends; the replay guard. */
  nonce: string;
}

/** Content of the `PAYMENT-SIGNATURE` header. */
export interface PaymentPayload {
  x402Version: 2;
  resource?: ResourceInfo;
  /** The `accepts[]` entry the buyer paid, verbatim. */
  accepted: PaymentRequirements;
  payload: CardanoExactPayload;
  extensions?: Extensions;
}

/** Settlement evidence in `SettlementResponse.extra`. */
export interface SettlementEvidence {
  status: 'mempool' | 'confirmed' | 'pending';
  /** -1 before block inclusion, else newer canonical blocks */
  confirmations: number;
  transactionId?: string;
}

/** Content of the `PAYMENT-RESPONSE` header and the facilitator's `/settle` answer. */
export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** Tx hash; empty string when nothing was broadcast. */
  transaction: string;
  network: string;
  /** Atomic units settled. */
  amount?: string;
  extensions?: Extensions;
  extra?: SettlementEvidence;
}

/** The facilitator's `/verify` answer. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
  extensions?: Extensions;
  extra?: Record<string, unknown>;
}

/** What the resource server learns about an accepted payment; handed to `onAccepted` and `req.payment`. */
export interface PaymentClaim {
  /** Lowercase hex, 64 chars. */
  txHash: string;
  /** Amount the matched `payTo` output carries, atomic units. */
  amountUnits: string;
  network: Network;
  /** `policyId+nameHex`; empty for lovelace. */
  unit: string;
  asset: string;
  payTo: string;
  /** The route the buyer paid for. */
  resourceUrl: string;
  /** `<txHash>#<index>` of the nonce UTxO. */
  nonceRef: string;
  /**
   * Bech32 address of the nonce UTxO, i.e. the buyer's own input, proven by
   * the signature that spent it. Unset when the backend could not resolve it.
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

/** The signed transaction of a `PaymentPayload`, parsed for validation. */
export interface DecodedPayment {
  payload: PaymentPayload;
  /** Hex of the signed-tx CBOR (preserved bytes, NOT a re-encode). */
  txCborHex: string;
  /** Hash of the tx body, lowercase 64-char hex. */
  txHash: string;
  outputs: DecodedOutput[];
  inputs: DecodedInput[];
  /** Native assets minted or burned; quantities signed. */
  mint: DecodedAsset[];
  /** Lovelace, decimal string. */
  fee: string;
  vkeyWitnessCount: number;
  /** Body network id: 1 mainnet, 0 testnet, null when absent. */
  networkId: number | null;
  /** False when the transaction declares a failing script (or the parser does not say); such a tx pays nothing. */
  isValid: boolean;
  /**
   * Body content that moves value the inputs and outputs do not show:
   * withdrawals, certificates, voting and proposal procedures, donation.
   */
  extraBodyContent: string[];
  /** blake2b-224 of each vkey whose signature over the body verifies. */
  signerKeyHashes: string[];
  /** Reasons a vkey witness failed; empty when all verify. */
  witnessErrors: string[];
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
  /** Byte length of the serialized output; unset when the parser does not report it. */
  cborSize?: number;
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
 * One payment option of a route. Lets a seller advertise e.g. "1 ADA or
 * 0.1 USDM" for the same route. Top-level middleware options (`payTo`,
 * `network`, `asset`, ...) fill any field the option leaves unset.
 */
export interface RouteOption {
  amount: string | number | bigint;
  asset?: string;
  payTo?: string;
  network?: Network | string;
  maxTimeoutSeconds?: number;
  extra?: PaymentExtra;
}

/**
 * What a `routePricing` entry or a `PriceResolver` may return.
 *
 *   - scalar             , single price in the route's default asset
 *   - `RouteOption`      , single option with field overrides
 *   - `RouteOption[]`    , multi-accept, buyer picks one
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
 * gate, a scalar / option / option-array to charge. The requirements it
 * returns must be the same on the paid retry, since the buyer's
 * `accepted` is matched exactly. Errors thrown here surface as 500.
 */
export type PriceResolver = (ctx: PricingContext) => PriceSpec | null | Promise<PriceSpec | null>;
