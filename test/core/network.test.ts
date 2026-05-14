import { parseNetwork, isNetwork, networksMatch } from '../../srv/core/network';
import { Codes, X402Error } from '../../srv/core/errors';

describe('isNetwork', () => {
  it.each([
    ['cardano:mainnet', true],
    ['cardano:preprod', true],
    ['cardano:preview', true],
    ['cardano-mainnet', false],
    ['cardano-preprod', false],
    ['mainnet',         false],
    ['',                false],
    [null,              false],
    [42,                false],
  ] as const)('isNetwork(%j) → %s', (input, expected) => {
    expect(isNetwork(input as unknown)).toBe(expected);
  });
});

describe('parseNetwork', () => {
  it.each(['cardano:mainnet', 'cardano:preprod', 'cardano:preview'])(
    'accepts %s',
    (n) => expect(parseNetwork(n)).toBe(n),
  );

  it('rejects v1 hyphen format with a precise hint', () => {
    expect.assertions(2);
    try { parseNetwork('cardano-preprod'); }
    catch (e) {
      const err = e as X402Error;
      expect(err.code).toBe(Codes.INVALID_NETWORK_FORMAT);
      expect(err.message).toMatch(/v1 hyphen format/);
    }
  });

  it('rejects unknown network names', () => {
    expect(() => parseNetwork('cardano:devnet')).toThrow(X402Error);
  });

  it('rejects non-string input', () => {
    expect(() => parseNetwork('' as unknown as string)).toThrow(/non-empty/);
  });
});

describe('networksMatch', () => {
  it('matches exact identity', () => {
    expect(networksMatch('cardano:preprod', 'cardano:preprod')).toBe(true);
  });
  it('rejects across networks', () => {
    expect(networksMatch('cardano:mainnet', 'cardano:preprod')).toBe(false);
  });
});
