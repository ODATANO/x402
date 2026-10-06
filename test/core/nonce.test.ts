import { parseNonceRef } from '../../srv/core/nonce';

const HASH = 'ab'.repeat(32);

describe('parseNonceRef', () => {
  it('parses <txHash>#<outputIndex>', () => {
    expect(parseNonceRef(`${HASH}#3`)).toEqual({ txHash: HASH, index: 3 });
  });

  it('lower-cases the hash', () => {
    expect(parseNonceRef(`${HASH.toUpperCase()}#0`)).toEqual({ txHash: HASH, index: 0 });
  });

  it('accepts output indexes from 0 to 65535', () => {
    expect(parseNonceRef(`${HASH}#0`)?.index).toBe(0);
    expect(parseNonceRef(`${HASH}#65535`)?.index).toBe(65535);
    expect(parseNonceRef(`${HASH}#65536`)).toBeNull();
    expect(parseNonceRef(`${HASH}#${'9'.repeat(30)}`)).toBeNull();
  });

  it.each([
    ['a hash of 62 chars', `${'ab'.repeat(31)}#0`],
    ['a hash of 66 chars', `${'ab'.repeat(33)}#0`],
    ['a non-hex hash', `${'zz'.repeat(32)}#0`],
    ['no index', HASH],
    ['an empty index', `${HASH}#`],
    ['a negative index', `${HASH}#-1`],
    ['a fractional index', `${HASH}#1.5`],
    ['a trailing part', `${HASH}#1#2`],
    ['surrounding spaces', ` ${HASH}#1 `],
    ['an empty string', ''],
  ])('rejects %s', (_label, nonce) => {
    expect(parseNonceRef(nonce)).toBeNull();
  });

  it.each([undefined, null, 42, {}, [`${HASH}#0`]])('rejects the non-string %p', (nonce) => {
    expect(parseNonceRef(nonce)).toBeNull();
  });
});
