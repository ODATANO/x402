// buildRequirements checks script extras through srv/bridge → @odatano/core.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import {
  buildRequirements,
  buildPaymentRequired,
  normalizeResource,
  assertConfirmationPolicy,
} from '../../srv/core/requirements';
import {
  SELLER_ADDR,
  BUYER_ADDR,
  SCRIPT_ADDR,
  SCRIPT_HASH,
  OTHER_SCRIPT_HASH,
  USDM_PREPROD_ASSET,
  NETWORK_PREPROD,
} from '../fixtures/constants';
import type { PaymentExtra, ScriptTransferExtra } from '../../srv/core/types';

const base = {
  amount:  '1000000',
  asset:   USDM_PREPROD_ASSET,
  payTo:   SELLER_ADDR,
  network: NETWORK_PREPROD,
};

describe('buildRequirements', () => {
  it('produces the v2 entry without a resource', () => {
    expect(buildRequirements(base)).toEqual({
      scheme:            'exact',
      network:           NETWORK_PREPROD,
      asset:             USDM_PREPROD_ASSET,
      amount:            '1000000',
      payTo:             SELLER_ADDR,
      maxTimeoutSeconds: 600,
      extra:             { areFeesSponsored: false },
    });
  });

  it('accepts string, number and bigint amounts', () => {
    expect(buildRequirements({ ...base, amount: 1_000_000 }).amount).toBe('1000000');
    expect(buildRequirements({ ...base, amount: 1_000_000n }).amount).toBe('1000000');
  });

  it.each(['0', '000', '-1', '1.5', 'abc'])('rejects amount %s', (amount) => {
    expect(() => buildRequirements({ ...base, amount })).toThrow(/positive integer/);
  });

  it('requires payTo', () => {
    expect(() => buildRequirements({ ...base, payTo: '' })).toThrow(/payTo is required/);
  });

  it('normalizes a CIP-34 network alias', () => {
    expect(buildRequirements({ ...base, network: 'cip34:0-1' }).network).toBe(NETWORK_PREPROD);
  });

  it('keeps extra fields and always sets areFeesSponsored false', () => {
    const e = buildRequirements({ ...base, extra: { decimals: 6, areFeesSponsored: true } });
    expect(e.extra).toEqual({ decimals: 6, areFeesSponsored: false });
  });

  it('honours maxTimeoutSeconds', () => {
    expect(buildRequirements({ ...base, maxTimeoutSeconds: 30 }).maxTimeoutSeconds).toBe(30);
  });

  it('writes the confirmationPolicy option into extra', () => {
    const e = buildRequirements({ ...base, confirmationPolicy: { l1Confirmations: 3 } });
    expect(e.extra?.confirmationPolicy).toEqual({ l1Confirmations: 3 });
  });

  it('prefers the confirmationPolicy in extra over the option', () => {
    const e = buildRequirements({
      ...base,
      extra: { confirmationPolicy: { l1Confirmations: 0 } },
      confirmationPolicy: { l1Confirmations: 5 },
    });
    expect(e.extra?.confirmationPolicy).toEqual({ l1Confirmations: 0 });
  });

  it.each([-2, 21, 1.5])('rejects l1Confirmations %s', (l1Confirmations) => {
    expect(() => buildRequirements({ ...base, confirmationPolicy: { l1Confirmations } })).toThrow(/-1 to 20/);
  });

  it('rejects a transfer method it cannot verify', () => {
    expect(() => buildRequirements({
      ...base,
      extra: { assetTransferMethod: 'masumi' } as unknown as PaymentExtra,
    })).toThrow(/'masumi' is not supported/);
  });
});

describe('assertConfirmationPolicy', () => {
  it.each([-1, 0, 20])('accepts %s', (n) => {
    expect(() => assertConfirmationPolicy({ l1Confirmations: n })).not.toThrow();
  });
  it.each([{}, null, { l1Confirmations: '1' }])('rejects %j', (p) => {
    expect(() => assertConfirmationPolicy(p)).toThrow();
  });
});

describe('buildRequirements, script transfer', () => {
  const core = jest.requireMock('@odatano/core') as { plutusScriptHash: jest.Mock };
  const scriptArgs = (extra: Partial<ScriptTransferExtra>, payTo: string = SCRIPT_ADDR) => ({
    amount: '2000000',
    asset:  'lovelace',
    payTo,
    network: NETWORK_PREPROD,
    extra: { assetTransferMethod: 'script' as const, scriptHash: SCRIPT_HASH, ...extra },
  });

  it('keeps the script extra on the entry', () => {
    const e = buildRequirements(scriptArgs({ datum: 'd8799f182aff' }));
    expect(e.extra).toEqual({
      assetTransferMethod: 'script', scriptHash: SCRIPT_HASH, datum: 'd8799f182aff', areFeesSponsored: false,
    });
  });

  it('requires scriptHash or script', () => {
    expect(() => buildRequirements(scriptArgs({ scriptHash: undefined }))).toThrow(/needs extra.scriptHash or extra.script/);
  });

  it('rejects a malformed scriptHash', () => {
    expect(() => buildRequirements(scriptArgs({ scriptHash: 'ABC' }))).toThrow(/56 hex chars/);
  });

  it('rejects a payTo that is not a script address', () => {
    expect(() => buildRequirements(scriptArgs({}, SELLER_ADDR))).toThrow(/payTo must be a script address/);
  });

  it('rejects a payTo of a different script', () => {
    expect(() => buildRequirements(scriptArgs({ scriptHash: OTHER_SCRIPT_HASH }))).toThrow(/is not the declared script/);
  });

  it('rejects a datum that is not CBOR PlutusData', () => {
    expect(() => buildRequirements(scriptArgs({ datum: 'xyz' }))).toThrow(/CBOR hex of PlutusData/);
    expect(() => buildRequirements(scriptArgs({ datum: 'ff' }))).toThrow(/CBOR hex of PlutusData/);
  });

  it('rejects plutusV1 and unknown script types', () => {
    expect(() => buildRequirements(scriptArgs({ script: { type: 'plutusV1', code: '00' } }))).toThrow(/'plutusV1' is not supported/);
    const script = { type: 'native', code: '00' } as unknown as ScriptTransferExtra['script'];
    expect(() => buildRequirements(scriptArgs({ script }))).toThrow(/'native' is not supported/);
  });

  it('accepts a script whose derived hash is the payTo credential', () => {
    core.plutusScriptHash.mockReturnValue(SCRIPT_HASH);
    const e = buildRequirements(scriptArgs({ scriptHash: undefined, script: { type: 'plutusV3', code: 'aabb' } }));
    expect(e.extra).toMatchObject({ script: { type: 'plutusV3', code: 'aabb' } });
  });
});

describe('normalizeResource', () => {
  it('expands a string to { url }', () => {
    expect(normalizeResource('/r')).toEqual({ url: '/r' });
  });

  it('keeps valid optional fields', () => {
    const r = { url: '/r', serviceName: 'Prices', tags: ['a', 'b'], iconUrl: 'https://x.io/i.png' };
    expect(normalizeResource(r)).toEqual(r);
  });

  it('requires a url', () => {
    expect(() => normalizeResource({ url: '' })).toThrow(/url is required/);
  });

  it.each([
    ['serviceName over 32 chars', { serviceName: 'x'.repeat(33) }],
    ['serviceName not ASCII',     { serviceName: 'Prëis' }],
    ['more than 5 tags',          { tags: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['tag over 32 chars',         { tags: ['x'.repeat(33)] }],
    ['relative iconUrl',          { iconUrl: '/icon.png' }],
    ['iconUrl over 2048 chars',   { iconUrl: `https://x.io/${'a'.repeat(2048)}` }],
  ])('rejects %s', (_name, fields) => {
    expect(() => normalizeResource({ url: '/r', ...fields })).toThrow();
  });
});

describe('buildPaymentRequired', () => {
  const args = { payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace', resource: '/r' };

  it('wraps the entries with one top-level resource', () => {
    const pr = buildPaymentRequired({ ...args, options: [{ amount: '1000000' }] });
    expect(pr.x402Version).toBe(2);
    expect(pr.resource).toEqual({ url: '/r' });
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).not.toHaveProperty('resource');
    expect(pr).not.toHaveProperty('error');
  });

  it('carries error and extensions when given', () => {
    const pr = buildPaymentRequired({ ...args, options: [{ amount: '1' }], error: 'x', extensions: { foo: {} } });
    expect(pr.error).toBe('x');
    expect(pr.extensions).toEqual({ foo: {} });
  });

  it('fills option defaults from the top level', () => {
    const pr = buildPaymentRequired({
      ...args,
      maxTimeoutSeconds: 120,
      confirmationPolicy: { l1Confirmations: 2 },
      options: [{ amount: '1000000' }, { amount: '5', asset: USDM_PREPROD_ASSET, payTo: BUYER_ADDR }],
    });
    expect(pr.accepts[0]).toMatchObject({ asset: 'lovelace', payTo: SELLER_ADDR, maxTimeoutSeconds: 120 });
    expect(pr.accepts[1]).toMatchObject({ asset: USDM_PREPROD_ASSET, payTo: BUYER_ADDR });
    expect(pr.accepts[1]!.extra?.confirmationPolicy).toEqual({ l1Confirmations: 2 });
  });

  it('lets an option extra replace the default extra', () => {
    const pr = buildPaymentRequired({
      ...args,
      extra: { tier: 'base' },
      options: [
        { amount: '1000000' },
        { amount: '2000000', payTo: SCRIPT_ADDR, extra: { assetTransferMethod: 'script', scriptHash: SCRIPT_HASH } },
      ],
    });
    expect(pr.accepts[0]!.extra).toEqual({ tier: 'base', areFeesSponsored: false });
    expect(pr.accepts[1]!.extra).toEqual({ assetTransferMethod: 'script', scriptHash: SCRIPT_HASH, areFeesSponsored: false });
  });

  it('rejects empty options', () => {
    expect(() => buildPaymentRequired({ ...args, options: [] })).toThrow(/non-empty/);
  });

  it('rejects an option without asset when no default is set', () => {
    expect(() => buildPaymentRequired({
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, resource: '/r', options: [{ amount: '1' }],
    })).toThrow(/missing `asset`/);
  });
});
