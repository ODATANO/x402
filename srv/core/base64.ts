/**
 * Base64 JSON for the x402 HTTP headers. Uses `Buffer` where it exists and
 * `btoa`/`atob` otherwise, so client bundles need no polyfill.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  // Browser path: build a binary string in chunks (spread has arg limits).
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Decodes strict base64; null when the input is not canonical base64. */
export function base64ToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64Json(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

/** Parsed JSON of a base64 header value; null when it is not base64 JSON. */
export function decodeBase64Json(s: string | null | undefined): unknown {
  if (!s) return null;
  const bytes = base64ToBytes(s.trim());
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
