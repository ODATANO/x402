/**
 * Cardano network identifiers of x402 v2: `cardano:mainnet | cardano:preprod |
 * cardano:preview`. The CIP-34 forms are accepted as input aliases and
 * normalized, as the Cardano `exact` spec requires.
 */

import { X402Error, Codes } from './errors';

export type Network = 'cardano:mainnet' | 'cardano:preprod' | 'cardano:preview';

const VALID = new Set<Network>(['cardano:mainnet', 'cardano:preprod', 'cardano:preview']);

/** CIP-34 `cip34:NetworkId-NetworkMagic` aliases; the set is closed. */
const CIP34_ALIASES: Record<string, Network> = {
  'cip34:1-764824073': 'cardano:mainnet',
  'cip34:0-1':         'cardano:preprod',
  'cip34:0-2':         'cardano:preview',
};

export function isNetwork(s: unknown): s is Network {
  return typeof s === 'string' && VALID.has(s as Network);
}

/** Canonical id for a canonical id or CIP-34 alias; null for anything else. */
export function normalizeNetwork(s: unknown): Network | null {
  if (isNetwork(s)) return s;
  return typeof s === 'string' ? CIP34_ALIASES[s] ?? null : null;
}

/** Validate a network string (canonical or CIP-34 alias) and return the canonical id. */
export function parseNetwork(s: string): Network {
  if (typeof s !== 'string' || s.length === 0) {
    throw new X402Error(Codes.INVALID_NETWORK_FORMAT, 'network must be a non-empty string');
  }
  const network = normalizeNetwork(s);
  if (!network) {
    throw new X402Error(
      Codes.INVALID_NETWORK_FORMAT,
      `network '${s}' is not one of cardano:mainnet | cardano:preprod | cardano:preview (or a CIP-34 alias)`,
    );
  }
  return network;
}

/** True iff both name the same network; CIP-34 aliases count as their canonical id. */
export function networksMatch(claimed: string, required: string): boolean {
  const a = normalizeNetwork(claimed);
  return a !== null && a === normalizeNetwork(required);
}

/** Shelley address network id: 1 on mainnet, 0 on the test networks. */
export function addressNetworkId(network: Network): 0 | 1 {
  return network === 'cardano:mainnet' ? 1 : 0;
}
