/**
 * Typed errors and reason codes of x402 (Cardano `exact`).
 *
 * The strings are the x402 v2 core codes where one exists, otherwise the
 * codes of the scheme's reference implementation, so clients see the same
 * reasons from any facilitator. They appear as `invalidReason`, as
 * `errorReason` and in the 402 `error` field.
 */

export class X402Error extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'X402Error';
    this.code = code;
  }
}

const P = 'invalid_exact_cardano_payload';

export const Codes = Object.freeze({
  // ---- payload / requirements shape (HTTP 400) ----
  MISSING_HEADER:          'missing_payment_header',
  INVALID_PAYLOAD:         'invalid_payload',
  UNSUPPORTED_VERSION:     'invalid_x402_version',
  UNSUPPORTED_SCHEME:      'unsupported_scheme',
  INVALID_NETWORK_FORMAT:  'invalid_network',
  INVALID_REQUIREMENTS:    'invalid_payment_requirements',
  INVALID_ASSET_FORMAT:    'invalid_payment_requirements',
  UNSUPPORTED_METHOD:      'invalid_exact_cardano_requirements',
  INVALID_POLICY:          'invalid_exact_cardano_requirements_policy',
  INVALID_CBOR:            `${P}_transaction_decode_failed`,
  INVALID_NONCE_FORMAT:    `${P}_nonce_invalid`,

  // ---- `accepted` not among the offered requirements ----
  ACCEPTED_MISMATCH:       'invalid_payment_requirements',

  // ---- facilitator verification rules ----
  NETWORK_MISMATCH:        `${P}_network_id_mismatch`,     // rule 1
  WRONG_RECIPIENT:         `${P}_recipient_mismatch`,      // rule 2
  INSUFFICIENT_AMOUNT:     `${P}_amount_insufficient`,     // rule 3
  WRONG_ASSET:             `${P}_asset_mismatch`,          // rule 4
  NONCE_NOT_REFERENCED:    `${P}_nonce_not_in_inputs`,     // rule 5
  REPLAY:                  `${P}_nonce_not_on_chain`,      // rule 5, nonce spent
  INPUT_NOT_AVAILABLE:     `${P}_input_not_available`,     // rule 5, other input spent
  VALUE_NOT_CONSERVED:     `${P}_value_not_conserved`,     // rule 6
  PHASE1_INVALID:          `${P}_phase1_invalid`,          // rule 6, value moved outside inputs and outputs (mint, ...)
  PHASE2_INVALID:          `${P}_phase2_invalid`,          // a script of the transaction fails; its outputs never exist
  FEE_BELOW_MINIMUM:       `${P}_fee_below_minimum`,       // rule 6
  UNSIGNED_TRANSACTION:    `${P}_unsigned`,                // rule 6
  INVALID_SIGNATURE:       `${P}_invalid_signature`,       // rule 6
  NOT_YET_VALID:           `${P}_not_yet_valid`,           // rule 6, validity start in the future
  EXPIRED_TTL:             `${P}_ttl_expired`,             // rule 7
  TTL_TOO_FAR:             `${P}_ttl_too_far`,             // rule 7
  MIN_UTXO_INSUFFICIENT:   `${P}_min_utxo_insufficient`,   // rule 8

  // ---- script transfer ----
  SCRIPT_ADDRESS_MISMATCH: `${P}_script_address_mismatch`,
  DATUM_MISSING:           `${P}_datum_missing`,
  DATUM_MISMATCH:          `${P}_datum_mismatch`,

  // ---- settle ----
  SUBMIT_FAILED:           'exact_cardano_settlement_definitively_rejected', // the ledger refused the transaction
  SETTLEMENT_FAILED:       'exact_cardano_settlement_failed',  // validity window closed, transaction never landed
  PENDING:                 'settlement_pending',
  DUPLICATE_SETTLEMENT:    'duplicate_settlement',
  UNEXPECTED_VERIFY_ERROR: 'unexpected_verify_error',
  UNEXPECTED_SETTLE_ERROR: 'unexpected_settle_error',

  // ---- resource server ----
  TRANSFER_REJECTED:       'transfer_rejected',            // verifyTransfer hook said no

  // ---- bridge / infrastructure ----
  BRIDGE_UNAVAILABLE:      'unexpected_verify_error',
} as const);

export type X402Code = typeof Codes[keyof typeof Codes];

/** Codes that mean the payload or requirements are malformed: HTTP 400 instead of 402. */
export const MALFORMED_CODES: ReadonlySet<string> = new Set([
  Codes.INVALID_PAYLOAD,
  Codes.UNSUPPORTED_VERSION,
  Codes.UNSUPPORTED_SCHEME,
  Codes.INVALID_NETWORK_FORMAT,
  Codes.INVALID_CBOR,
  Codes.INVALID_NONCE_FORMAT,
]);
