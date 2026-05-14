import { X402Error, Codes, type X402Code } from '../../srv/core/errors';

describe('X402Error', () => {
  it('exposes code, name, and message', () => {
    const e = new X402Error(Codes.NETWORK_MISMATCH, 'mismatch');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(X402Error);
    expect(e.code).toBe(Codes.NETWORK_MISMATCH);
    expect(e.name).toBe('X402Error');
    expect(e.message).toBe('mismatch');
  });

  it('uses code as message when none given', () => {
    const e = new X402Error(Codes.MISSING_HEADER);
    expect(e.message).toBe(Codes.MISSING_HEADER);
  });
});

describe('Codes table', () => {
  const allCodes = Object.values(Codes) as X402Code[];

  it('is frozen', () => {
    expect(Object.isFrozen(Codes)).toBe(true);
  });

  it('uses lower_snake_case identifiers (masumi convention)', () => {
    for (const c of allCodes) {
      expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('has unique values', () => {
    expect(new Set(allCodes).size).toBe(allCodes.length);
  });

  it('contains the 6 mandatory-check codes', () => {
    expect(allCodes).toEqual(expect.arrayContaining([
      Codes.NETWORK_MISMATCH,
      Codes.WRONG_RECIPIENT,
      Codes.INSUFFICIENT_AMOUNT,
      Codes.WRONG_ASSET,
      Codes.REPLAY,
      Codes.EXPIRED_TTL,
    ]));
  });
});
