/**
 * Cardano-x402-v2 network identifiers.
 *
 * v2 uses **colon** as separator: `cardano:mainnet | cardano:preprod | cardano:preview`.
 * v1 used hyphen (`cardano-mainnet`). We accept only the v2 form on input
 * and refuse v1 strings so callers can't silently misroute funds across
 * networks.
 */

import { X402Error, Codes } from './errors';

export type Network = 'cardano:mainnet' | 'cardano:preprod' | 'cardano:preview';

const VALID = new Set<Network>(['cardano:mainnet', 'cardano:preprod', 'cardano:preview']);

export function isNetwork(s: unknown): s is Network {
  return typeof s === 'string' && VALID.has(s as Network);
}

/**
 * Validate a network string and return it typed. Throws X402Error on
 * malformed input, including v1-style hyphen variants, so the caller's
 * 402 body carries a precise diagnostic.
 */
export function parseNetwork(s: string): Network {
  if (typeof s !== 'string' || s.length === 0) {
    throw new X402Error(Codes.INVALID_NETWORK_FORMAT, 'network must be a non-empty string');
  }
  if (s.includes('-') && !s.includes(':')) {
    throw new X402Error(
      Codes.INVALID_NETWORK_FORMAT,
      `network '${s}' uses v1 hyphen format; v2 requires colon: 'cardano:mainnet|preprod|preview'`,
    );
  }
  if (!isNetwork(s)) {
    throw new X402Error(
      Codes.INVALID_NETWORK_FORMAT,
      `network '${s}' is not one of cardano:mainnet | cardano:preprod | cardano:preview`,
    );
  }
  return s;
}

/** True iff `payload.network` (the buyer's claim) matches the server's requirement. */
export function networksMatch(claimed: string, required: Network): boolean {
  return claimed === required;
}
