/**
 * Cardano-x402-v2 asset identifier handling.
 *
 * v2 expresses an asset as a single string:
 *   - For native assets:  `<policyIdHex>.<assetNameHex>`  (DOT separator)
 *     where policyId is 28 bytes (56 hex chars) and assetNameHex is 0..64 hex chars.
 *     An empty name (NFT-style) is `<policyIdHex>.`
 *   - For ADA:            the literal string `'lovelace'`
 *
 * v1 split policy and name across `asset` + `extra.assetNameHex`; we
 * refuse that shape outright so consumers can't mix specs.
 */

import { X402Error, Codes } from './errors';

export interface ParsedAsset {
  /** raw v2 string as emitted by buildPaymentRequirements */
  raw: string;
  /** true when the asset is ADA (lovelace) */
  isLovelace: boolean;
  /** lowercase 56-char hex; empty string when isLovelace */
  policyId: string;
  /** lowercase hex, 0..64 chars; empty string when isLovelace OR when name is empty */
  assetNameHex: string;
  /**
   * Concatenation used as the canonical UTxO `unit` key by Blockfrost /
   * Koios / ODATANO (`policyId + assetNameHex`). Empty for lovelace ,
   * comparisons against UTxO assets short-circuit via `isLovelace`.
   */
  unit: string;
}

const POLICY_RE = /^[0-9a-f]{56}$/i;
const NAME_RE   = /^[0-9a-f]{0,64}$/i;

/** Parse a v2 asset string. Throws X402Error on malformed input. */
export function parseAsset(s: string): ParsedAsset {
  if (typeof s !== 'string' || s.length === 0) {
    throw new X402Error(Codes.INVALID_ASSET_FORMAT, 'asset must be a non-empty string');
  }
  if (s === 'lovelace') {
    return { raw: s, isLovelace: true, policyId: '', assetNameHex: '', unit: '' };
  }

  const dot = s.indexOf('.');
  if (dot < 0) {
    throw new X402Error(
      Codes.INVALID_ASSET_FORMAT,
      `asset '${s}' must be 'lovelace' or '<policyIdHex>.<assetNameHex>' (dot-separated)`,
    );
  }
  const policyId     = s.slice(0, dot).toLowerCase();
  const assetNameHex = s.slice(dot + 1).toLowerCase();

  if (!POLICY_RE.test(policyId)) {
    throw new X402Error(
      Codes.INVALID_ASSET_FORMAT,
      `asset policyId '${policyId}' must be 28-byte (56-char) hex`,
    );
  }
  if (!NAME_RE.test(assetNameHex)) {
    throw new X402Error(
      Codes.INVALID_ASSET_FORMAT,
      `asset name '${assetNameHex}' must be 0..32 byte (0..64 char) hex`,
    );
  }

  return {
    raw:          s,
    isLovelace:   false,
    policyId,
    assetNameHex,
    unit:         (policyId + assetNameHex).toLowerCase(),
  };
}

/** Build a v2 asset string from policy + assetName parts. */
export function buildAssetString(policyId: string, assetNameHex: string = ''): string {
  if (!POLICY_RE.test(policyId)) {
    throw new X402Error(
      Codes.INVALID_ASSET_FORMAT,
      `buildAssetString: policyId '${policyId}' must be 56-char hex`,
    );
  }
  if (assetNameHex && !NAME_RE.test(assetNameHex)) {
    throw new X402Error(
      Codes.INVALID_ASSET_FORMAT,
      `buildAssetString: assetNameHex '${assetNameHex}' must be 0..64-char hex`,
    );
  }
  return `${policyId.toLowerCase()}.${assetNameHex.toLowerCase()}`;
}
