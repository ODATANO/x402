/**
 * Typed errors for x402 (Cardano-v2) verification.
 *
 * Codes stay in lower_snake to match the masumi-spec convention so they
 * are interoperable with v1 callers grepping for known strings. Codes
 * specific to v2 (UTxO-ref nonce, TTL window) are marked below.
 *
 * The `code` field is surfaced in the 402 response body's `error` field
 * (parenthesised after the human message), so it doubles as the
 * machine-readable diagnostic for clients.
 */

export class X402Error extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'X402Error';
    this.code = code;
  }
}

export const Codes = Object.freeze({
  // ---- decode ----
  MISSING_HEADER:        'missing_payment_header',
  INVALID_BASE64:        'invalid_base64',
  INVALID_JSON:          'invalid_json',
  MISSING_FIELD:         'missing_field',
  UNSUPPORTED_VERSION:   'unsupported_version',
  UNSUPPORTED_SCHEME:    'unsupported_scheme',
  UNSUPPORTED_METHOD:    'unsupported_transfer_method',
  INVALID_CBOR:          'invalid_cbor',
  INVALID_NETWORK_FORMAT:'invalid_network_format', // v2 requires 'cardano:<net>'
  INVALID_ASSET_FORMAT:  'invalid_asset_format',   // v2 requires '<policy>.<nameHex>'
  INVALID_NONCE_FORMAT:  'invalid_nonce_format',   // v2 requires '<txHash>#<index>'

  // ---- validate (6 mandatory facilitator checks) ----
  NETWORK_MISMATCH:      'network_mismatch',         // check 1
  WRONG_RECIPIENT:       'wrong_recipient',          // check 2
  INSUFFICIENT_AMOUNT:   'insufficient_amount',      // check 3
  WRONG_ASSET:           'wrong_asset',              // check 4
  REPLAY:                'replay_detected',          // check 5 — UTxO already spent
  NONCE_NOT_REFERENCED:  'nonce_not_referenced',     // check 5 — UTxO not in tx inputs
  EXPIRED_TTL:           'expired_ttl',              // check 6 — validity range upper bound passed

  // ---- supporting ----
  UNSIGNED_TRANSACTION:  'unsigned_transaction',     // sanity: no vkey witnesses

  // ---- settle ----
  SUBMIT_FAILED:         'submit_failed',
  PENDING:               'invalid_transaction_state', // matches masumi spec

  // ---- bridge / infrastructure ----
  BRIDGE_UNAVAILABLE:    'bridge_unavailable',
} as const);

export type X402Code = typeof Codes[keyof typeof Codes];
