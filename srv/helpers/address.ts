/**
 * Minimal, CSL-free Shelley address introspection.
 *
 * The unsigned-tx builder needs two things from the buyer's bech32
 * address that the (Buildooor-based) @odatano/core builder doesn't hand
 * back: the payment-credential VKey hash (returned to the wallet as the
 * `requiredSignerHex`), and a guard that the address is a Base/Enterprise
 * key-cred address (script-cred and reward/stake addresses can't sign a
 * normal spend). Rather than pull in a CBOR/address library, we decode
 * the bech32 payload and read the 1-byte Shelley header directly.
 *
 * Shelley address header (CIP-19): the top nibble is the address type,
 * the bottom nibble the network id. Payment credential is the 28 bytes
 * following the header. Payment-cred kind by type:
 *   0,2 base / 6 enterprise → key hash    (signable)
 *   1,3 base / 7 enterprise → script hash (not signable)
 *   4,5 pointer             → unsupported here
 *   14,15 reward/stake      → not a payment address
 */

import { bech32 } from 'bech32';

const PAYMENT_KEY_HASH_TYPES = new Set([0, 2, 6]); // base-key, base-key/script-stake, enterprise-key
const SCRIPT_PAYMENT_TYPES   = new Set([1, 3, 7]); // base-script*, enterprise-script

/** Bech32 limit well above Cardano's longest (~103-char mainnet base addr). */
const BECH32_LIMIT = 1023;

export interface ParsedPaymentAddress {
  /** Buyer's payment-credential VKey hash (lowercase hex, 56 chars). */
  paymentKeyHashHex: string;
}

/**
 * Decode a bech32 Cardano address and extract its payment-credential
 * VKey hash. Throws (with the same messages the old CSL path used) for
 * malformed bech32, script-cred payment, or non-payment (reward/pointer)
 * addresses.
 */
export function parsePaymentAddress(bech32Addr: string): ParsedPaymentAddress {
  let bytes: Uint8Array;
  try {
    const decoded = bech32.decode(bech32Addr, BECH32_LIMIT);
    bytes = Uint8Array.from(bech32.fromWords(decoded.words));
  } catch {
    throw new Error(`buildUnsignedPaymentTx: invalid bech32 address: ${bech32Addr}`);
  }

  // header (1 byte) + 28-byte payment credential.
  if (bytes.length < 29) {
    throw new Error(`buildUnsignedPaymentTx: invalid bech32 address: ${bech32Addr}`);
  }

  const addrType = bytes[0]! >> 4;

  if (SCRIPT_PAYMENT_TYPES.has(addrType)) {
    throw new Error('buildUnsignedPaymentTx: payment credential must be a VKey hash, not a script');
  }
  if (!PAYMENT_KEY_HASH_TYPES.has(addrType)) {
    // pointer (4,5), reward/stake (14,15), Byron-via-bech32, etc.
    throw new Error('buildUnsignedPaymentTx: only Base / Enterprise addresses are supported');
  }

  const keyHash = bytes.slice(1, 29);
  return { paymentKeyHashHex: Buffer.from(keyHash).toString('hex') };
}
