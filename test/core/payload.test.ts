import { parsePaymentPayload } from '../../srv/core/payload';
import { Codes, X402Error } from '../../srv/core/errors';
import { encodeRawPayload } from '../fixtures/envelope';
import { SELLER_ADDR, NETWORK_PREPROD, NONCE_REF } from '../fixtures/constants';

const accepted = {
  scheme: 'exact', network: NETWORK_PREPROD, asset: 'lovelace', amount: '1000000',
  payTo: SELLER_ADDR, maxTimeoutSeconds: 600,
};
const valid = {
  x402Version: 2,
  resource: { url: '/r' },
  accepted,
  payload: { transaction: 'AAAA', nonce: NONCE_REF },
};

function codeOf(header: string | undefined): string | undefined {
  try {
    parsePaymentPayload(header);
    return undefined;
  } catch (e) {
    return (e as X402Error).code;
  }
}

const withChange = (change: Record<string, unknown>) => encodeRawPayload({ ...valid, ...change });

describe('parsePaymentPayload', () => {
  it('returns a well-formed payload', () => {
    expect(parsePaymentPayload(encodeRawPayload(valid))).toEqual(valid);
  });

  it('accepts a CIP-34 alias network and extensions', () => {
    const p = parsePaymentPayload(withChange({ accepted: { ...accepted, network: 'cip34:0-1' }, extensions: { x: {} } }));
    expect(p.accepted.network).toBe('cip34:0-1');
    expect(p.extensions).toEqual({ x: {} });
  });

  it('reports a missing header', () => {
    expect(codeOf(undefined)).toBe(Codes.MISSING_HEADER);
  });

  it.each([
    ['not base64',               '%%%'],
    ['base64 but not JSON',      Buffer.from('nope').toString('base64')],
    ['a JSON array',             encodeRawPayload([1, 2])],
    ['no accepted',              withChange({ accepted: undefined })],
    ['accepted without payTo',   withChange({ accepted: { ...accepted, payTo: undefined } })],
    ['accepted without timeout', withChange({ accepted: { ...accepted, maxTimeoutSeconds: '600' } })],
    ['extra not an object',      withChange({ accepted: { ...accepted, extra: 'x' } })],
    ['no transaction',           withChange({ payload: { nonce: NONCE_REF } })],
    ['resource without url',     withChange({ resource: { description: 'x' } })],
    ['extensions not an object', withChange({ extensions: [] })],
  ])('rejects %s with invalid_payload', (_name, header) => {
    expect(codeOf(header)).toBe(Codes.INVALID_PAYLOAD);
  });

  it('rejects a foreign x402Version', () => {
    expect(codeOf(withChange({ x402Version: 1 }))).toBe(Codes.UNSUPPORTED_VERSION);
  });

  it('rejects a scheme other than exact', () => {
    expect(codeOf(withChange({ accepted: { ...accepted, scheme: 'upto' } }))).toBe(Codes.UNSUPPORTED_SCHEME);
  });

  it('rejects a non-Cardano network', () => {
    expect(codeOf(withChange({ accepted: { ...accepted, network: 'eip155:8453' } }))).toBe(Codes.INVALID_NETWORK_FORMAT);
  });

  it.each(['', 'abc#0', `${'a'.repeat(64)}`, `${'a'.repeat(64)}#x`])('rejects nonce %j', (nonce) => {
    expect(codeOf(withChange({ payload: { transaction: 'AAAA', nonce } }))).toBe(Codes.INVALID_NONCE_FORMAT);
  });
});
