/**
 * Test fixtures shared across the suite.
 *
 * Two preprod test addresses (buyer + seller) derived from deterministic
 * 32-byte seeds. Deterministic so test failures reproduce regardless of
 * CI environment.
 *
 * Keys/addresses are built with `@harmoniclabs/buildooor` (the same
 * stack @odatano/core uses), so the suite carries no CSL dependency.
 *
 * One synthetic preprod-style native asset (policy `a0…a0`, name `BEEF1`).
 * One synthetic txHash hex for use as a nonce-UTxO reference (any 64-char
 * hex is on-chain-shaped; nothing validates it as a real on-chain tx
 * until the chain-touching tests, which mock that step).
 */

import {
  Address,
  Credential,
  blake2b_224,
  deriveEd25519PublicKey_sync,
} from '@harmoniclabs/buildooor';

export const NETWORK_PREPROD = 'cardano:preprod' as const;
export const NETWORK_MAINNET = 'cardano:mainnet' as const;

// ─── Deterministic test keys + addresses ─────────────────────────────
// A raw 32-byte ed25519 key; `signEd25519_sync` derives the public key
// from it, so this doubles as both "private key" and seed.
function keyFromSeed(seedHex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(seedHex, 'hex'));
}

const BUYER_SEED  = 'aa'.repeat(32);
const SELLER_SEED = 'bb'.repeat(32);

export const BUYER_PRIV  = keyFromSeed(BUYER_SEED);
export const SELLER_PRIV = keyFromSeed(SELLER_SEED);
export const BUYER_PUB   = deriveEd25519PublicKey_sync(BUYER_PRIV);
export const SELLER_PUB  = deriveEd25519PublicKey_sync(SELLER_PRIV);
export const BUYER_VKH   = Buffer.from(blake2b_224(BUYER_PUB)).toString('hex');
export const SELLER_VKH  = Buffer.from(blake2b_224(SELLER_PUB)).toString('hex');

// preprod = testnet network id. Enterprise (no stake cred) key-hash address.
function enterpriseBech32(vkhHex: string): string {
  return Address.testnet(Credential.keyHash(vkhHex)).toString();
}

export const BUYER_ADDR  = enterpriseBech32(BUYER_VKH);
export const SELLER_ADDR = enterpriseBech32(SELLER_VKH);

// ─── Synthetic native asset ──────────────────────────────────────────
export const TEST_POLICY_ID    = 'a0'.repeat(28);   // 56 hex chars
export const TEST_ASSET_NAME   = '4245454631';      // "BEEF1" in hex
export const TEST_ASSET_STRING = `${TEST_POLICY_ID}.${TEST_ASSET_NAME}`;
export const TEST_ASSET_UNIT   = (TEST_POLICY_ID + TEST_ASSET_NAME).toLowerCase();

// Real USDM-preprod policy from the spec, for asset-format tests:
export const USDM_PREPROD_POLICY = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde';
export const USDM_NAME_HEX       = '0014df105553444d';
export const USDM_PREPROD_ASSET  = `${USDM_PREPROD_POLICY}.${USDM_NAME_HEX}`;

// ─── Nonce-UTxO reference ────────────────────────────────────────────
export const NONCE_TX_HASH = 'dead'.repeat(16);     // 64 hex chars
export const NONCE_INDEX   = 0;
export const NONCE_REF     = `${NONCE_TX_HASH}#${NONCE_INDEX}`;

// ─── Slots ───────────────────────────────────────────────────────────
/** A representative preprod slot, used as "now" in TTL tests. */
export const CURRENT_SLOT = 80_000_000;
export const FUTURE_SLOT  = CURRENT_SLOT + 3600; // ~1h ahead
export const PAST_SLOT    = CURRENT_SLOT - 3600; // ~1h ago
