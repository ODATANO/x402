/**
 * Thin adapter over `@odatano/core`'s programmatic Cardano client.
 *
 * The x402 modules (facilitator, helpers, middleware) all import from
 * here so the underlying ODATANO surface is the only thing they couple
 * to, and so renames in core (`getTransaction` → `getTransactionByHash`)
 * stay isolated to this file.
 *
 * Two methods specific to Cardano-x402-v2 are first-class on
 * `@odatano/core` since `1.7.8` (our minimum peer):
 *   - `isUtxoUnspent(txHash, outputIndex)` for replay-defense check 5b
 *   - `getCurrentSlot()`                   for TTL check 6
 *
 * Both are called through directly here; no shim layer remains.
 */

import { X402Error, Codes } from './core/errors';

// We load `@odatano/core` via `require()` and declare the minimal
// surface we use locally, rather than `import * as odatano from
// '@odatano/core'`. The published `@odatano/core` ships compiled
// `.js`/`.d.ts` only, so the project graph stays clean either way;
// the local declaration keeps the static coupling to one file and
// shields downstream callers from rename churn in core's barrel.

// ─── Raw shapes returned by @odatano/core's normalised client ─────────
interface RawAmount  { unit?: string; quantity?: string | number }
interface RawUtxo {
  txHash?: string;
  outputIndex?: number | string;
  address?: string;
  amount?: RawAmount[];
  datumHash?: string;
  scriptRef?: string;
  inlineDatum?: string | null;
}
interface CardanoClient {
  getAddressUtxos(address: string): Promise<RawUtxo[]>;
  getTransaction(txHash: string): Promise<unknown>;
  getProtocolParameters(): Promise<unknown>;
  submitTransaction(cborHex: string): Promise<string>;
  getCurrentSlot(): Promise<number>;
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean>;
}

/**
 * Core's Buildooor-backed transfer builder. We only use the two
 * non-script entry points; both do their own UTxO fetch + coin
 * selection + change/min-ADA from `senderAddress`.
 */
interface CardanoTxBuilder {
  buildSimpleAdaTransaction(req: CoreTransferReq, params: unknown): Promise<CoreTxBuildResult>;
  buildMultiAssetTransaction(req: CoreTransferReq, params: unknown): Promise<CoreTxBuildResult>;
}

interface OdatanoModule {
  initialize(): Promise<unknown>;
  shutdown(): Promise<unknown>;
  getCardanoClient(): CardanoClient;
  getCardanoTxBuilder(): CardanoTxBuilder;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const od: OdatanoModule = require('@odatano/core');

// ─── Normalised flat UTxO shape we expose to the rest of x402 ─────────
export interface BridgeAsset {
  unit: string;          // policyId + assetNameHex, lowercase hex
  policyId: string;
  assetNameHex: string;
  quantity: string;
}
export interface BridgeUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  lovelace: string;
  assets: BridgeAsset[];
  dataHash?: string;
  inlineDatumHex?: string;
  referenceScriptHash?: string;
}

// ─── Init guard: cache the promise so concurrent callers share it ─────
let initPromise: Promise<unknown> | null = null;
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = od.initialize().catch(err => {
      initPromise = null;
      throw new X402Error(Codes.BRIDGE_UNAVAILABLE, `@odatano/core init failed: ${(err as Error)?.message ?? err}`);
    });
  }
  await initPromise;
}

function mapUtxo(u: RawUtxo): BridgeUtxo {
  const amount = u.amount ?? [];
  const lovelaceEntry = amount.find(a => a.unit === 'lovelace');
  const lovelace = String(lovelaceEntry?.quantity ?? '0');

  const assets: BridgeAsset[] = amount
    .filter(a => a.unit !== 'lovelace')
    .map(a => {
      const unit = String(a.unit ?? '').toLowerCase();
      return {
        unit,
        policyId:     unit.slice(0, 56),
        assetNameHex: unit.slice(56),
        quantity:     String(a.quantity ?? '0'),
      };
    });

  return {
    txHash:              String(u.txHash ?? ''),
    outputIndex:         Number(u.outputIndex ?? 0),
    address:             String(u.address ?? ''),
    lovelace,
    assets,
    dataHash:            u.datumHash ?? undefined,
    inlineDatumHex:      u.inlineDatum ?? undefined,
    referenceScriptHash: u.scriptRef ?? undefined,
  };
}

// ─── Public API ───────────────────────────────────────────────────────

/** Init the underlying @odatano/core client. Idempotent. */
export async function init(): Promise<void> { await ensureInit(); }

/** Force re-init on next call (used by tests / supervised reloads). */
export async function shutdown(): Promise<void> {
  try { await od.shutdown(); }
  finally { initPromise = null; }
}

/**
 * Fetch UTxOs at a bech32 address, flat-mapped to BridgeUtxo[].
 */
export async function getUtxosAtAddress(address: string): Promise<BridgeUtxo[]> {
  if (!address) throw new TypeError('getUtxosAtAddress: address required');
  await ensureInit();
  const rows = await od.getCardanoClient().getAddressUtxos(address);
  return Array.isArray(rows) ? rows.map(mapUtxo) : [];
}

/**
 * Fetch a tx by hash. Returns `null` on 404 (tx not on chain yet) so
 * the settle/verify-confirmed paths can poll without try/catch noise.
 */
export async function getTransactionByHash(txHash: string): Promise<unknown> {
  if (!txHash) throw new TypeError('getTransactionByHash: txHash required');
  await ensureInit();
  try {
    return await od.getCardanoClient().getTransaction(txHash);
  } catch (err) {
    const e = err as { code?: number; statusCode?: number; message?: string };
    if (e?.code === 404 || e?.statusCode === 404 || /not.?found/i.test(e?.message ?? '')) {
      return null;
    }
    throw err;
  }
}

export async function getProtocolParameters(): Promise<unknown> {
  await ensureInit();
  return od.getCardanoClient().getProtocolParameters();
}

export async function submitTransaction(signedCborHex: string): Promise<string> {
  if (!signedCborHex) throw new TypeError('submitTransaction: signedCborHex required');
  await ensureInit();
  return od.getCardanoClient().submitTransaction(signedCborHex);
}

/**
 * Current chain tip slot. First-class method on `CardanoClient` since
 * `@odatano/core@1.7.8`, wraps `getLatestBlock().slot` with a
 * `ProviderUnavailableError` translation so consumers don't deal with
 * `null` slots.
 */
export async function getCurrentSlot(): Promise<number> {
  await ensureInit();
  return od.getCardanoClient().getCurrentSlot();
}

/**
 * Check whether a UTxO is still unspent. First-class method since
 * `@odatano/core@1.7.8`, backed by `consumed_by` (Blockfrost) /
 * `is_spent` (Koios) / `queryLedgerState/utxo` (Ogmios).
 *
 * Returns `false` for txs that don't exist on chain or for
 * out-of-range output indices, both are "not spendable" from the
 * caller's perspective.
 */
export async function isUtxoUnspent(
  txHash: string,
  outputIndex: number,
): Promise<boolean> {
  if (!txHash) throw new TypeError('isUtxoUnspent: txHash required');
  if (!Number.isInteger(outputIndex) || outputIndex < 0) {
    throw new TypeError('isUtxoUnspent: outputIndex must be a non-negative integer');
  }
  await ensureInit();
  return od.getCardanoClient().isUtxoUnspent(txHash, outputIndex);
}

// ─── Pure CBOR parse (no chain call, no init) ─────────────────────────
// `parseTransaction` is a pure, Buildooor-backed export of
// `@odatano/core` (CSL-free since core@1.8.0). It replaces the local
// CSL `Transaction`/`FixedTransaction` parsing that decode.ts used to
// do, so x402 no longer needs a CBOR library of its own. The byte
// hash it returns (`body.hash`) is byte-preserving, exactly the
// property the old `FixedTransaction` path relied on.

/** One output of a parsed tx. `assets[].unit` is `policyId+nameHex`. */
export interface ParsedTxOutput {
  address: string;
  lovelace: string;
  assets: Array<{ unit: string; quantity: string }>;
  datumHash: string | null;
  inlineDatumHex: string | null;
  referenceScriptHex: string | null;
}

/** Structured shape returned by `@odatano/core`'s `parseTransaction`. */
export interface ParsedTx {
  txHash: string;
  network: 'mainnet' | 'testnet' | null;
  inputs: Array<{ txHash: string; outputIndex: number }>;
  outputs: ParsedTxOutput[];
  /** Validity-range lower bound in slots (decimal string) or null. */
  validityStart: string | null;
  /** Validity-range upper bound (TTL) in slots (decimal string) or null. */
  validityEnd: string | null;
  fee: string;
  mint: Array<{ unit: string; quantity: string }>;
  requiredSigners: string[];
  scriptDataHash: string | null;
  witnesses: {
    vkeyCount: number;
    nativeScripts: number;
    plutusScripts: number;
    plutusData: number;
    redeemers: number;
  };
}

const odParseTransaction = (
  od as unknown as { parseTransaction?: (cborHex: string) => ParsedTx }
).parseTransaction;

/**
 * Parse signed-or-unsigned tx CBOR (hex) into structured fields. Pure,
 * no init / no chain call. Throws `X402Error(INVALID_CBOR)` on malformed
 * input so callers in the decode path get a precise, surfaceable code.
 */
export function parseTransaction(cborHex: string): ParsedTx {
  if (typeof odParseTransaction !== 'function') {
    throw new X402Error(
      Codes.BRIDGE_UNAVAILABLE,
      '@odatano/core does not export parseTransaction (need >= 1.9.1)',
    );
  }
  try {
    return odParseTransaction(cborHex);
  } catch (err) {
    throw new X402Error(
      Codes.INVALID_CBOR,
      `transaction CBOR did not decode: ${(err as Error)?.message ?? err}`,
    );
  }
}

// ─── Server-side unsigned transfer build (delegated to core) ──────────
// The browser-buyer flow builds the payment tx server-side (the wallet
// only signs). We hand the whole job — UTxO fetch, coin selection,
// change, min-ADA, fee — to core's Buildooor builder rather than
// hand-rolling it, so x402 carries no tx-construction library of its own.

/** Request shape accepted by core's `build{Simple,MultiAsset}Transaction`. */
export interface CoreTransferReq {
  /** Buyer's bech32 — UTxO source and default change address. */
  senderAddress: string;
  /** Bech32 recipient (`payTo`). */
  recipientAddress: string;
  /** Defaults to `senderAddress`. */
  changeAddress?: string;
  /** Output ADA in lovelace (decimal string). For token outputs this is the riding min-ADA. */
  lovelaceAmount: string;
  /** Native assets on the output. `unit` = `policyId+assetNameHex`. Omit/empty for pure ADA. */
  assets?: Array<{ unit: string; quantity: string }>;
  /** Validity-range upper bound as POSIX ms; core converts to a slot. */
  validityEndMs?: number;
}

/** Subset of core's `TxBuildResult` that x402 consumes. */
export interface CoreTxBuildResult {
  unsignedTxCbor: string;
  txBodyHash: string;
  inputs: Array<{ txHash: string; index: number; lovelace: string }>;
  outputs: Array<{ address: string; lovelace: string }>;
  feeLovelace: string;
}

/**
 * Build an unsigned transfer tx via core's Buildooor builder. Routes to
 * the multi-asset entry point when `assets` is non-empty (it rejects an
 * empty asset list), otherwise the plain-ADA one.
 */
export async function buildUnsignedTransfer(
  req: CoreTransferReq,
): Promise<CoreTxBuildResult> {
  await ensureInit();
  const builder = od.getCardanoTxBuilder();
  // Core's builder expects core's own protocol-parameter shape, so source
  // it from the same client rather than re-deriving it here.
  const params = await od.getCardanoClient().getProtocolParameters();
  return req.assets && req.assets.length > 0
    ? builder.buildMultiAssetTransaction(req, params)
    : builder.buildSimpleAdaTransaction(req, params);
}
