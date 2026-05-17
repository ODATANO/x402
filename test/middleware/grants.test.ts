/**
 * Tests for the CAP-backed grants module.
 *
 * INSERT / SELECT are CDS globals; @sap/cds places them on globalThis
 * the moment it is required. We stub them per-test so we can drive
 * success, DB failure, and lookup outcomes deterministically.
 */

import '@sap/cds'; // ensures globals exist before we override
import {
  DEFAULT_GRANTS_ENTITY,
  DEFAULT_GRANT_TTL_SECONDS,
  resolveGrantsEntity,
  resolveGrantTtl,
  issueGrant,
  lookupGrant,
} from '../../srv/middleware/grants';
import type { PaymentClaim } from '../../srv/core/types';

const baseClaim: PaymentClaim = {
  txHash:      'ab'.repeat(32),
  payerAddr:   'addr_test1qpayer',
  payTo:       'addr_test1qseller',
  asset:       'lovelace',
  amountUnits: '1000000',
  network:     'cardano:preprod',
  nonceRef:    'ab'.repeat(32) + '#0',
};

// `INSERT` / `SELECT` are getter-only globals defined by @sap/cds, so
// plain assignment fails. We redefine them per-test with a configurable
// data descriptor; an afterEach restores the original getter descriptors.
const insertDesc = Object.getOwnPropertyDescriptor(globalThis, 'INSERT');
const selectDesc = Object.getOwnPropertyDescriptor(globalThis, 'SELECT');

function setINSERT(impl: unknown) {
  Object.defineProperty(globalThis, 'INSERT', { value: impl, configurable: true, writable: true });
}
function setSELECT(impl: unknown) {
  Object.defineProperty(globalThis, 'SELECT', { value: impl, configurable: true, writable: true });
}

afterEach(() => {
  if (insertDesc) Object.defineProperty(globalThis, 'INSERT', insertDesc);
  if (selectDesc) Object.defineProperty(globalThis, 'SELECT', selectDesc);
});

describe('resolveGrantsEntity', () => {
  it('returns null when grants is undefined / false', () => {
    expect(resolveGrantsEntity(undefined)).toBeNull();
    expect(resolveGrantsEntity(false)).toBeNull();
  });

  it('returns the default entity when grants is `true`', () => {
    expect(resolveGrantsEntity(true)).toBe(DEFAULT_GRANTS_ENTITY);
  });

  it('returns a custom entity name when provided', () => {
    expect(resolveGrantsEntity({ entity: 'my.ns.MyGrants' })).toBe('my.ns.MyGrants');
  });

  it('falls back to the default entity when only ttl is set', () => {
    expect(resolveGrantsEntity({ ttlSeconds: 60 })).toBe(DEFAULT_GRANTS_ENTITY);
  });
});

describe('resolveGrantTtl', () => {
  it('returns the default when grants is undefined / true', () => {
    expect(resolveGrantTtl(undefined)).toBe(DEFAULT_GRANT_TTL_SECONDS);
    expect(resolveGrantTtl(true)).toBe(DEFAULT_GRANT_TTL_SECONDS);
  });

  it('returns the override when set', () => {
    expect(resolveGrantTtl({ ttlSeconds: 60 })).toBe(60);
  });

  it('falls back to default when only entity is set', () => {
    expect(resolveGrantTtl({ entity: 'x' })).toBe(DEFAULT_GRANT_TTL_SECONDS);
  });
});

describe('issueGrant', () => {
  it('inserts a row and returns the token + ISO expiry', async () => {
    const entries = jest.fn().mockResolvedValue(undefined);
    const into    = jest.fn(() => ({ entries }));
    setINSERT({ into });

    const result = await issueGrant('odatano.x402.X402Grants', baseClaim, '/api/foo', 60);
    expect(result).not.toBeNull();
    expect(result!.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Date(result!.expiresAt).toString()).not.toBe('Invalid Date');
    expect(into).toHaveBeenCalledWith('odatano.x402.X402Grants');
    const row = entries.mock.calls[0][0];
    expect(row.token).toBe(result!.token);
    expect(row.route).toBe('/api/foo');
    expect(row.payerAddr).toBe(baseClaim.payerAddr);
    expect(row.txHash).toBe(baseClaim.txHash);
    expect(typeof row.ID).toBe('string');
  });

  it('writes payerAddr=null when the claim has none', async () => {
    const entries = jest.fn().mockResolvedValue(undefined);
    setINSERT({ into: () => ({ entries }) });

    const claim: PaymentClaim = { ...baseClaim, payerAddr: undefined };
    await issueGrant(DEFAULT_GRANTS_ENTITY, claim, '/api/foo', 60);
    expect(entries.mock.calls[0][0].payerAddr).toBeNull();
  });

  it('returns null and logs when INSERT fails', async () => {
    setINSERT({ into: () => ({ entries: () => Promise.reject(new Error('db down')) }) });
    const out = await issueGrant(DEFAULT_GRANTS_ENTITY, baseClaim, '/api/foo', 60);
    expect(out).toBeNull();
  });

  it('handles non-Error rejection objects without crashing', async () => {
    setINSERT({ into: () => ({ entries: () => Promise.reject('weird thing') }) });
    const out = await issueGrant(DEFAULT_GRANTS_ENTITY, baseClaim, '/api/foo', 60);
    expect(out).toBeNull();
  });
});

describe('lookupGrant', () => {
  function selectReturning(row: { expiresAt?: string } | null) {
    return {
      one: {
        from: () => ({ where: () => Promise.resolve(row) }),
      },
    };
  }

  it('short-circuits as not-found for empty tokens without touching SELECT', async () => {
    const from = jest.fn();
    setSELECT({ one: { from } });
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, '', '/api/foo');
    expect(out).toEqual({ kind: 'not-found' });
    expect(from).not.toHaveBeenCalled();
  });

  it('returns valid when a row with future expiry exists', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    setSELECT(selectReturning({ expiresAt: future }));
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, 'tok', '/api/foo');
    expect(out).toEqual({ kind: 'valid' });
  });

  it('returns expired when the row is past its expiry', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    setSELECT(selectReturning({ expiresAt: past }));
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, 'tok', '/api/foo');
    expect(out).toEqual({ kind: 'expired' });
  });

  it('returns expired when expiresAt is unparseable', async () => {
    setSELECT(selectReturning({ expiresAt: 'not-a-date' }));
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, 'tok', '/api/foo');
    expect(out).toEqual({ kind: 'expired' });
  });

  it('returns expired when the row has no expiresAt', async () => {
    setSELECT(selectReturning({}));
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, 'tok', '/api/foo');
    expect(out).toEqual({ kind: 'expired' });
  });

  it('returns not-found when no row matches', async () => {
    setSELECT(selectReturning(null));
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, 'tok', '/api/foo');
    expect(out).toEqual({ kind: 'not-found' });
  });

  it('treats DB errors as not-found (logs + falls through)', async () => {
    setSELECT({ one: { from: () => ({ where: () => Promise.reject(new Error('db down')) }) } });
    const out = await lookupGrant(DEFAULT_GRANTS_ENTITY, 'tok', '/api/foo');
    expect(out).toEqual({ kind: 'not-found' });
  });
});
