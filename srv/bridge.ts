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

interface OdatanoModule {
  initialize(): Promise<unknown>;
  shutdown(): Promise<unknown>;
  getCardanoClient(): CardanoClient;
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

// ─── Re-export pure CBOR utilities (no bridge round-trip) ─────────────
// parseTransaction is exported from @odatano/core's barrel and runs
// entirely client-side. Re-export so x402 users don't need a second
// import for tx introspection. We declare the type loosely (unknown
// CBOR-parsed shape), consumers cast to ODATANO's `ParsedTransaction`
// from `@odatano/core` directly if they need the structured fields.
export const parseTransaction = od ? (od as unknown as { parseTransaction?: (cborHex: string) => unknown }).parseTransaction : undefined;
