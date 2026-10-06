import { bytesToBase64, base64ToBytes, encodeBase64Json, decodeBase64Json } from '../../srv/core/base64';

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = Uint8Array.from([0, 1, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips JSON', () => {
    const v = { a: 1, b: ['ü', null] };
    expect(decodeBase64Json(encodeBase64Json(v))).toEqual(v);
  });

  it.each(['abc', 'ab$=', 'a=bc'])('rejects non-canonical base64 %j', (s) => {
    expect(base64ToBytes(s)).toBeNull();
  });

  it('returns null for empty, non-base64 or non-JSON input', () => {
    expect(decodeBase64Json(undefined)).toBeNull();
    expect(decodeBase64Json('')).toBeNull();
    expect(decodeBase64Json('###')).toBeNull();
    expect(decodeBase64Json(Buffer.from('not json').toString('base64'))).toBeNull();
  });
});
