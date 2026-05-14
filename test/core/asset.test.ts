import { parseAsset, buildAssetString } from '../../srv/core/asset';
import { Codes, X402Error } from '../../srv/core/errors';
import { USDM_PREPROD_POLICY, USDM_NAME_HEX, USDM_PREPROD_ASSET } from '../fixtures/constants';

describe('parseAsset', () => {
  it('parses lovelace literal', () => {
    const a = parseAsset('lovelace');
    expect(a.isLovelace).toBe(true);
    expect(a.policyId).toBe('');
    expect(a.assetNameHex).toBe('');
    expect(a.unit).toBe('');
    expect(a.raw).toBe('lovelace');
  });

  it('parses a real preprod USDM asset string', () => {
    const a = parseAsset(USDM_PREPROD_ASSET);
    expect(a.isLovelace).toBe(false);
    expect(a.policyId).toBe(USDM_PREPROD_POLICY.toLowerCase());
    expect(a.assetNameHex).toBe(USDM_NAME_HEX.toLowerCase());
    expect(a.unit).toBe((USDM_PREPROD_POLICY + USDM_NAME_HEX).toLowerCase());
  });

  it('lowercases mixed-case input', () => {
    const a = parseAsset(USDM_PREPROD_ASSET.toUpperCase());
    expect(a.policyId).toBe(USDM_PREPROD_POLICY.toLowerCase());
    expect(a.assetNameHex).toBe(USDM_NAME_HEX.toLowerCase());
  });

  it('accepts an empty asset name (NFT-style policy-only)', () => {
    const a = parseAsset(`${USDM_PREPROD_POLICY}.`);
    expect(a.assetNameHex).toBe('');
    expect(a.unit).toBe(USDM_PREPROD_POLICY.toLowerCase());
  });

  it('rejects v1-style separate-field shape (no dot)', () => {
    expect(() => parseAsset(USDM_PREPROD_POLICY))
      .toThrow(X402Error);
    try { parseAsset(USDM_PREPROD_POLICY); }
    catch (e) { expect((e as X402Error).code).toBe(Codes.INVALID_ASSET_FORMAT); }
  });

  it('rejects empty string', () => {
    expect(() => parseAsset('')).toThrow(X402Error);
  });

  it('rejects non-hex policyId', () => {
    expect(() => parseAsset('zz'.repeat(28) + '.' + USDM_NAME_HEX))
      .toThrow(/policyId/);
  });

  it('rejects policyId of wrong length', () => {
    expect(() => parseAsset('aa'.repeat(27) + '.' + USDM_NAME_HEX))
      .toThrow(/56-char/);
  });

  it('rejects an asset name longer than 32 bytes', () => {
    expect(() => parseAsset(`${USDM_PREPROD_POLICY}.${'aa'.repeat(33)}`))
      .toThrow(/0..32 byte/);
  });
});

describe('buildAssetString', () => {
  it('builds from valid policyId + nameHex', () => {
    expect(buildAssetString(USDM_PREPROD_POLICY, USDM_NAME_HEX))
      .toBe(`${USDM_PREPROD_POLICY.toLowerCase()}.${USDM_NAME_HEX.toLowerCase()}`);
  });

  it('builds from policyId only (NFT-style)', () => {
    expect(buildAssetString(USDM_PREPROD_POLICY)).toBe(`${USDM_PREPROD_POLICY.toLowerCase()}.`);
  });

  it('rejects bad policyId', () => {
    expect(() => buildAssetString('short')).toThrow(X402Error);
  });

  it('rejects bad assetNameHex', () => {
    expect(() => buildAssetString(USDM_PREPROD_POLICY, 'zz')).toThrow(X402Error);
  });

  it('round-trips through parseAsset', () => {
    const s = buildAssetString(USDM_PREPROD_POLICY, USDM_NAME_HEX);
    const a = parseAsset(s);
    expect(a.policyId + a.assetNameHex).toBe((USDM_PREPROD_POLICY + USDM_NAME_HEX).toLowerCase());
  });
});
