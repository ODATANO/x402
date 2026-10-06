/**
 * Grants against a real in-memory sqlite: issuing a token, looking it up
 * by route and expiry, and the transaction the row is written in.
 */

import cds from '@sap/cds';
import {
  issueGrant,
  lookupGrant,
  resolveGrantTtl,
  DEFAULT_GRANTS_ENTITY,
  DEFAULT_GRANT_TTL_SECONDS,
} from '../../srv/middleware/grants';
import { deployTestDb, closeTestDb, rowsOf } from '../fixtures/db';
import { BUYER_ADDR, SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';
import type { PaymentClaim } from '../../srv/core/types';

const ROUTE = '/odata/v4/prices/Quotes';

function claim(payerAddr: string | undefined = BUYER_ADDR): PaymentClaim {
  return {
    txHash:      'b1'.repeat(32),
    amountUnits: '1000000',
    network:     NETWORK_PREPROD,
    unit:        '',
    asset:       'lovelace',
    payTo:       SELLER_ADDR,
    resourceUrl: ROUTE,
    nonceRef:    `${'dd'.repeat(32)}#0`,
    ...(payerAddr ? { payerAddr } : {}),
  };
}

const grantOf = async (token: string) =>
  (await rowsOf<Record<string, unknown>>(DEFAULT_GRANTS_ENTITY)).find(r => r.token === token);

let warn: jest.SpyInstance;

beforeAll(deployTestDb);
afterAll(closeTestDb);
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

describe('resolveGrantTtl', () => {
  it('is the default unless ttlSeconds is set', () => {
    expect(resolveGrantTtl(undefined)).toBe(DEFAULT_GRANT_TTL_SECONDS);
    expect(resolveGrantTtl(true)).toBe(DEFAULT_GRANT_TTL_SECONDS);
    expect(resolveGrantTtl({ entity: 'x' })).toBe(DEFAULT_GRANT_TTL_SECONDS);
    expect(resolveGrantTtl({ ttlSeconds: 60 })).toBe(60);
  });
});

describe('issueGrant', () => {
  it('returns a token with its expiry and stores the row', async () => {
    const before = Date.now();
    const grant = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, 60);
    expect(grant!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expires = Date.parse(grant!.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);

    const row = await grantOf(grant!.token);
    expect(row).toMatchObject({
      token:     grant!.token,
      route:     ROUTE,
      payerAddr: BUYER_ADDR,
      txHash:    'b1'.repeat(32),
      asset:     'lovelace',
      network:   NETWORK_PREPROD,
    });
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(String(row!.expiresAt))).toBe(expires);
    expect(Number.isNaN(Date.parse(String(row!.issuedAt)))).toBe(false);
  });

  it('writes payerAddr null when the claim has none', async () => {
    const grant = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(''), ROUTE, 60);
    expect((await grantOf(grant!.token))!.payerAddr).toBeNull();
  });

  it('issues a different token every time', async () => {
    const a = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, 60);
    const b = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, 60);
    expect(a!.token).not.toBe(b!.token);
  });

  it('commits on its own, so the grant survives a failing outer transaction', async () => {
    let token = '';
    await expect(cds.tx(async () => {
      token = (await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, 60))!.token;
      throw new Error('request failed');
    })).rejects.toThrow('request failed');
    expect(await grantOf(token)).toBeDefined();
  });

  it('returns null and logs when the insert fails', async () => {
    expect(await issueGrant('no.such.Entity', claim(), ROUTE, 60)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain('no.such.Entity');
  });
});

describe('lookupGrant', () => {
  it('finds a live grant for its route', async () => {
    const grant = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, 60);
    expect(await lookupGrant(DEFAULT_GRANTS_ENTITY, grant!.token, ROUTE)).toEqual({ kind: 'valid' });
  });

  it('does not unlock another route', async () => {
    const grant = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, 60);
    expect(await lookupGrant(DEFAULT_GRANTS_ENTITY, grant!.token, '/odata/v4/prices/getBestPrice'))
      .toEqual({ kind: 'not-found' });
  });

  it('reports a grant past its expiry as expired', async () => {
    const grant = await issueGrant(DEFAULT_GRANTS_ENTITY, claim(), ROUTE, -60);
    expect(await lookupGrant(DEFAULT_GRANTS_ENTITY, grant!.token, ROUTE)).toEqual({ kind: 'expired' });
  });

  it('reports a grant without expiry as expired', async () => {
    await cds.tx(tx => tx.run(cds.ql.INSERT.into(DEFAULT_GRANTS_ENTITY).entries({
      id: cds.utils.uuid(), token: 'no-expiry', route: ROUTE,
    })));
    expect(await lookupGrant(DEFAULT_GRANTS_ENTITY, 'no-expiry', ROUTE)).toEqual({ kind: 'expired' });
  });

  it('reports an unknown token as not-found', async () => {
    expect(await lookupGrant(DEFAULT_GRANTS_ENTITY, 'unknown-token', ROUTE)).toEqual({ kind: 'not-found' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers not-found for an empty token without a query', async () => {
    const tx = jest.spyOn(cds, 'tx');
    expect(await lookupGrant(DEFAULT_GRANTS_ENTITY, '', ROUTE)).toEqual({ kind: 'not-found' });
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
  });

  it('answers not-found and logs when the query fails', async () => {
    expect(await lookupGrant('no.such.Entity', 'tok', ROUTE)).toEqual({ kind: 'not-found' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain('no.such.Entity');
  });
});
