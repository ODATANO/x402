/**
 * Test fixtures shared across the suite.
 *
 * Two preprod test addresses (buyer + seller) generated from
 * deterministic 32-byte seeds. Deterministic so that test failures
 * are reproducible regardless of CI environment.
 *
 * One synthetic preprod-style native asset (policy `aa…aa`, name `BEEF`).
 * One real txHash hex for use as nonce-UTxO reference (any 64-char hex
 * is on-chain-shaped; nothing validates it as a real on-chain tx
 * until the chain-touching tests, which mock that step).
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

export const NETWORK_PREPROD = 'cardano:preprod' as const;
export const NETWORK_MAINNET = 'cardano:mainnet' as const;

// ─── Deterministic test keys + addresses ─────────────────────────────
function privFromSeed(seedHex: string): CSL.PrivateKey {
  // Ed25519 extended key from a 32-byte seed. Use raw normal_bytes path —
  // deterministic, no BIP32 dance.
  return CSL.PrivateKey.from_normal_bytes(Buffer.from(seedHex, 'hex'));
}

const BUYER_SEED  = 'aa'.repeat(32);
const SELLER_SEED = 'bb'.repeat(32);

export const BUYER_PRIV   = privFromSeed(BUYER_SEED);
export const SELLER_PRIV  = privFromSeed(SELLER_SEED);
export const BUYER_PUB    = BUYER_PRIV.to_public();
export const SELLER_PUB   = SELLER_PRIV.to_public();
export const BUYER_VKH    = BUYER_PUB.hash();
export const SELLER_VKH   = SELLER_PUB.hash();

// preprod = network id 0
const NET_ID = CSL.NetworkInfo.testnet_preprod().network_id();

function enterpriseBech32(keyHash: CSL.Ed25519KeyHash): string {
  return CSL.EnterpriseAddress.new(NET_ID, CSL.Credential.from_keyhash(keyHash))
    .to_address()
    .to_bech32();
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
/** A representative preprod slot — used as "now" in TTL tests. */
export const CURRENT_SLOT = 80_000_000;
export const FUTURE_SLOT  = CURRENT_SLOT + 3600; // ~1h ahead
export const PAST_SLOT    = CURRENT_SLOT - 3600; // ~1h ago
