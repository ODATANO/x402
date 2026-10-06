import { X402Error, Codes, MALFORMED_CODES } from '../../srv/core/errors';

describe('X402Error', () => {
  it('exposes code, name and message', () => {
    const e = new X402Error(Codes.NETWORK_MISMATCH, 'mismatch');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(Codes.NETWORK_MISMATCH);
    expect(e.name).toBe('X402Error');
    expect(e.message).toBe('mismatch');
  });

  it('uses the code as message when none is given', () => {
    expect(new X402Error(Codes.MISSING_HEADER).message).toBe(Codes.MISSING_HEADER);
  });
});

describe('Codes', () => {
  it('is frozen and lower_snake_case', () => {
    expect(Object.isFrozen(Codes)).toBe(true);
    for (const c of Object.values(Codes)) expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('uses the x402 v2 core codes', () => {
    expect(Codes.INVALID_PAYLOAD).toBe('invalid_payload');
    expect(Codes.UNSUPPORTED_VERSION).toBe('invalid_x402_version');
    expect(Codes.UNSUPPORTED_SCHEME).toBe('unsupported_scheme');
    expect(Codes.INVALID_NETWORK_FORMAT).toBe('invalid_network');
    expect(Codes.PENDING).toBe('settlement_pending');
    expect(Codes.DUPLICATE_SETTLEMENT).toBe('duplicate_settlement');
  });

  it('uses the Cardano reference codes for verification rules', () => {
    expect(Codes.WRONG_RECIPIENT).toBe('invalid_exact_cardano_payload_recipient_mismatch');
    expect(Codes.INSUFFICIENT_AMOUNT).toBe('invalid_exact_cardano_payload_amount_insufficient');
    expect(Codes.TTL_TOO_FAR).toBe('invalid_exact_cardano_payload_ttl_too_far');
    expect(Codes.SCRIPT_ADDRESS_MISMATCH).toBe('invalid_exact_cardano_payload_script_address_mismatch');
    expect(Codes.PHASE1_INVALID).toBe('invalid_exact_cardano_payload_phase1_invalid');
    expect(Codes.PHASE2_INVALID).toBe('invalid_exact_cardano_payload_phase2_invalid');
    expect(Codes.SUBMIT_FAILED).toBe('exact_cardano_settlement_definitively_rejected');
    expect(Codes.SETTLEMENT_FAILED).toBe('exact_cardano_settlement_failed');
  });
});

describe('MALFORMED_CODES', () => {
  it('holds the payload shape codes (HTTP 400)', () => {
    for (const c of [Codes.INVALID_PAYLOAD, Codes.UNSUPPORTED_VERSION, Codes.UNSUPPORTED_SCHEME,
      Codes.INVALID_NETWORK_FORMAT, Codes.INVALID_CBOR, Codes.INVALID_NONCE_FORMAT]) {
      expect(MALFORMED_CODES.has(c)).toBe(true);
    }
  });

  it('excludes payment failures and the accepted mismatch (HTTP 402)', () => {
    for (const c of [Codes.ACCEPTED_MISMATCH, Codes.WRONG_RECIPIENT, Codes.EXPIRED_TTL, Codes.PENDING]) {
      expect(MALFORMED_CODES.has(c)).toBe(false);
    }
  });
});
