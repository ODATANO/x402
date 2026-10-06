/** The replay nonce of Cardano `exact`: a UTxO reference `<txHash>#<outputIndex>`. */

const NONCE_RE = /^([0-9a-f]{64})#(\d+)$/i;

/** Parsed reference, or null when `nonce` is not `<64 hex>#<index up to 65535>`. */
export function parseNonceRef(nonce: unknown): { txHash: string; index: number } | null {
  const m = typeof nonce === 'string' ? NONCE_RE.exec(nonce) : null;
  if (!m) return null;
  const index = Number(m[2]);
  return Number.isInteger(index) && index <= 65535 ? { txHash: m[1]!.toLowerCase(), index } : null;
}
