/**
 * Build PAYMENT-SIGNATURE envelopes (v2 wire format) for tests.
 *
 * Mirror of the shape consumed by `srv/core/decode.ts`. The base64
 * step matters: `srv/core/decode.ts` rejects malformed base64 strictly,
 * so the fixture must produce canonical base64 too.
 */

export interface EnvelopeArgs {
  txCborHex: string;
  nonceRef: string;                   // '<txHash>#<index>'
  network?: string;                   // default 'cardano:preprod'
  x402Version?: number;               // default 2
  scheme?: string;                    // default 'exact'
  /** Allows test cases to corrupt specific fields. */
  overrides?: Record<string, unknown>;
}

export function buildEnvelope(args: EnvelopeArgs): string {
  const txB64 = Buffer.from(args.txCborHex, 'hex').toString('base64');
  const env = {
    x402Version: args.x402Version ?? 2,
    scheme:      args.scheme ?? 'exact',
    network:     args.network ?? 'cardano:preprod',
    payload: {
      transaction: txB64,
      nonce:       args.nonceRef,
    },
    ...args.overrides,
  };
  return Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
}

/** Encode an arbitrary JSON-like object as a PAYMENT-SIGNATURE value. */
export function encodeRawEnvelope(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}
