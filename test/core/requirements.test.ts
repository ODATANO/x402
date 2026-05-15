import {
  buildPaymentRequirements,
  buildPaymentRequirementsMulti,
  buildEntry,
  flatRequirements,
} from '../../srv/core/requirements';
import {
  SELLER_ADDR,
  BUYER_ADDR,
  USDM_PREPROD_ASSET,
  NETWORK_PREPROD,
} from '../fixtures/constants';

describe('buildEntry', () => {
  const baseArgs = {
    amount: '1000000',
    asset:  USDM_PREPROD_ASSET,
    payTo:  SELLER_ADDR,
    network: NETWORK_PREPROD,
    resource: { url: '/odata/v4/foo/getBar', description: 'X', mimeType: 'application/json' },
  };

  it('produces the canonical v2 entry shape', () => {
    const e = buildEntry(baseArgs);
    expect(e).toEqual({
      scheme: 'exact',
      network: NETWORK_PREPROD,
      asset:   USDM_PREPROD_ASSET,
      amount:  '1000000',
      payTo:   SELLER_ADDR,
      resource: { url: '/odata/v4/foo/getBar', description: 'X', mimeType: 'application/json' },
      assetTransferMethod: 'default',
      maxTimeoutSeconds: 600,
    });
  });

  it('amount accepts string|number|bigint', () => {
    expect(buildEntry({ ...baseArgs, amount: 1_000_000 }).amount).toBe('1000000');
    expect(buildEntry({ ...baseArgs, amount: 1_000_000n }).amount).toBe('1000000');
  });

  it('rejects zero or non-positive amount', () => {
    expect(() => buildEntry({ ...baseArgs, amount: '0' })).toThrow(/positive integer/);
    expect(() => buildEntry({ ...baseArgs, amount: '-1' })).toThrow(/positive integer/);
    expect(() => buildEntry({ ...baseArgs, amount: '1.5' })).toThrow(/positive integer/);
  });

  it('rejects missing payTo', () => {
    expect(() => buildEntry({ ...baseArgs, payTo: '' })).toThrow(/payTo/);
  });

  it('rejects v1 network format', () => {
    expect(() => buildEntry({ ...baseArgs, network: 'cardano-preprod' as never })).toThrow();
  });

  it('rejects v1 separate-field asset shape', () => {
    expect(() => buildEntry({ ...baseArgs, asset: '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde' }))
      .toThrow();
  });

  it('accepts string resource (sugars into descriptor)', () => {
    const e = buildEntry({ ...baseArgs, resource: '/foo' });
    expect(e.resource).toEqual({ url: '/foo', description: '', mimeType: 'application/json' });
  });

  it('description / mimeType overrides take precedence', () => {
    const e = buildEntry({
      ...baseArgs,
      resource: { url: '/foo', description: 'old', mimeType: 'text/plain' },
      description: 'new',
      mimeType: 'application/cbor',
    });
    expect(e.resource).toEqual({ url: '/foo', description: 'new', mimeType: 'application/cbor' });
  });

  it('attaches extra fields when provided', () => {
    const e = buildEntry({ ...baseArgs, extra: { decimals: 6, fingerprint: 'asset12…' } });
    expect(e.extra).toEqual({ decimals: 6, fingerprint: 'asset12…' });
  });

  it('honours assetTransferMethod override', () => {
    const e = buildEntry({ ...baseArgs, assetTransferMethod: 'masumi' });
    expect(e.assetTransferMethod).toBe('masumi');
  });

  it('honours maxTimeoutSeconds override', () => {
    const e = buildEntry({ ...baseArgs, maxTimeoutSeconds: 30 });
    expect(e.maxTimeoutSeconds).toBe(30);
  });
});

describe('buildPaymentRequirements', () => {
  const baseArgs = {
    amount: '1000000',
    asset: USDM_PREPROD_ASSET,
    payTo: SELLER_ADDR,
    network: NETWORK_PREPROD,
    resource: { url: '/x', description: '', mimeType: 'application/json' },
  };

  it('wraps a single entry in the 402 envelope', () => {
    const body = buildPaymentRequirements(baseArgs);
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    expect(body.error).toBeUndefined();
  });

  it('emits the missing-header error string when requested', () => {
    const body = buildPaymentRequirements({ ...baseArgs, withMissingHeaderError: true });
    expect(body.error).toBe('PAYMENT-SIGNATURE header is required');
  });
});

describe('buildPaymentRequirementsMulti', () => {
  const baseArgs = {
    payTo:    SELLER_ADDR,
    network:  NETWORK_PREPROD,
    asset:    'lovelace',
    resource: '/multi',
  };

  it('produces one accepts[] entry per option, inheriting defaults', () => {
    const body = buildPaymentRequirementsMulti({
      ...baseArgs,
      options: [
        { amount: '500000' },                            // inherits lovelace + SELLER_ADDR
        { amount: '100000', asset: USDM_PREPROD_ASSET }, // overrides asset
      ],
    });
    expect(body.accepts).toHaveLength(2);
    expect(body.accepts[0]!.asset).toBe('lovelace');
    expect(body.accepts[0]!.payTo).toBe(SELLER_ADDR);
    expect(body.accepts[1]!.asset).toBe(USDM_PREPROD_ASSET);
    expect(body.accepts[1]!.payTo).toBe(SELLER_ADDR);
  });

  it('per-option payTo / network / assetTransferMethod override top-level defaults', () => {
    const body = buildPaymentRequirementsMulti({
      ...baseArgs,
      options: [
        { amount: '1000000', payTo: BUYER_ADDR, assetTransferMethod: 'masumi' },
      ],
    });
    expect(body.accepts[0]!.payTo).toBe(BUYER_ADDR);
    expect(body.accepts[0]!.assetTransferMethod).toBe('masumi');
  });

  it('throws on empty options array', () => {
    expect(() =>
      buildPaymentRequirementsMulti({ ...baseArgs, options: [] }),
    ).toThrow(/non-empty/);
  });

  it('throws when an option lacks asset and no top-level asset is set', () => {
    const { asset: _unused, ...withoutAsset } = baseArgs;
    void _unused;
    expect(() =>
      buildPaymentRequirementsMulti({ ...withoutAsset, options: [{ amount: '1' }] }),
    ).toThrow(/asset/);
  });

  it('emits the missing-header error string when requested', () => {
    const body = buildPaymentRequirementsMulti({
      ...baseArgs,
      options: [{ amount: '500000' }],
      withMissingHeaderError: true,
    });
    expect(body.error).toBe('PAYMENT-SIGNATURE header is required');
  });
});

describe('flatRequirements', () => {
  it('returns accepts[0]', () => {
    const body = buildPaymentRequirements({
      amount: '1',
      asset: USDM_PREPROD_ASSET,
      payTo: SELLER_ADDR,
      network: NETWORK_PREPROD,
      resource: '/r',
    });
    expect(flatRequirements(body)).toBe(body.accepts[0]);
  });

  it('throws on empty accepts', () => {
    expect(() => flatRequirements({ x402Version: 2, accepts: [] }))
      .toThrow(/accepts is empty/);
  });
});
