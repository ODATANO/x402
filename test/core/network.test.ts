import {
  parseNetwork, isNetwork, networksMatch, normalizeNetwork, addressNetworkId,
} from '../../srv/core/network';
import { Codes, X402Error } from '../../srv/core/errors';

describe('isNetwork', () => {
  it.each([
    ['cardano:mainnet', true],
    ['cardano:preprod', true],
    ['cardano:preview', true],
    ['cip34:0-2',       false],
    ['cardano-preprod', false],
    ['',                false],
    [null,              false],
    [42,                false],
  ] as const)('isNetwork(%j) → %s', (input, expected) => {
    expect(isNetwork(input as unknown)).toBe(expected);
  });
});

describe('normalizeNetwork', () => {
  it.each([
    ['cardano:preview',   'cardano:preview'],
    ['cip34:1-764824073', 'cardano:mainnet'],
    ['cip34:0-1',         'cardano:preprod'],
    ['cip34:0-2',         'cardano:preview'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeNetwork(input)).toBe(expected);
  });

  it.each(['cip34:0-3', 'cardano:devnet', 'cardano-preprod', '', 7])('rejects %j', (input) => {
    expect(normalizeNetwork(input)).toBeNull();
  });
});

describe('parseNetwork', () => {
  it('returns canonical ids unchanged', () => {
    expect(parseNetwork('cardano:preprod')).toBe('cardano:preprod');
  });

  it('normalizes CIP-34 aliases', () => {
    expect(parseNetwork('cip34:0-2')).toBe('cardano:preview');
  });

  it('rejects unknown networks with invalid_network', () => {
    expect.assertions(1);
    try { parseNetwork('cardano:devnet'); } catch (e) {
      expect((e as X402Error).code).toBe(Codes.INVALID_NETWORK_FORMAT);
    }
  });

  it('rejects the empty string', () => {
    expect(() => parseNetwork('')).toThrow(/non-empty/);
  });
});

describe('networksMatch', () => {
  it('matches identical ids', () => {
    expect(networksMatch('cardano:preprod', 'cardano:preprod')).toBe(true);
  });
  it('treats an alias as its canonical id', () => {
    expect(networksMatch('cip34:1-764824073', 'cardano:mainnet')).toBe(true);
  });
  it('rejects different networks', () => {
    expect(networksMatch('cip34:0-1', 'cardano:preview')).toBe(false);
  });
  it('rejects unknown ids', () => {
    expect(networksMatch('cardano:devnet', 'cardano:devnet')).toBe(false);
  });
});

describe('addressNetworkId', () => {
  it('is 1 on mainnet and 0 on the test networks', () => {
    expect(addressNetworkId('cardano:mainnet')).toBe(1);
    expect(addressNetworkId('cardano:preprod')).toBe(0);
    expect(addressNetworkId('cardano:preview')).toBe(0);
  });
});
