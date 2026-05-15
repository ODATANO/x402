/**
 * CAP middleware tests.
 *
 * gateService registers a single `srv.before('*', handler)`. We capture
 * that handler in a fake service, then invoke it with hand-rolled
 * cds.Request mocks and assert on the side effects (req.reject calls,
 * stashed claim, response header set).
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

const mockProcess = jest.fn();
jest.mock('../../srv/facilitator/verify', () => ({
  process: (...args: unknown[]) => mockProcess(...args),
}));

const mockPersistReceipt = jest.fn();
jest.mock('../../srv/middleware/receipts', () => {
  // Keep `resolveReceiptsEntity` real so the option-shape parsing is
  // exercised end-to-end; only the INSERT call is intercepted.
  const actual = jest.requireActual('../../srv/middleware/receipts');
  return {
    ...actual,
    persistReceipt: (...args: unknown[]) => mockPersistReceipt(...args),
  };
});

const mockIssueGrant  = jest.fn();
const mockLookupGrant = jest.fn();
jest.mock('../../srv/middleware/grants', () => {
  const actual = jest.requireActual('../../srv/middleware/grants');
  return {
    ...actual,
    issueGrant:  (...args: unknown[]) => mockIssueGrant(...args),
    lookupGrant: (...args: unknown[]) => mockLookupGrant(...args),
  };
});

import { gateService } from '../../srv/middleware/cap';
import { Codes } from '../../srv/core/errors';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';

interface CapturedReq {
  event: string;
  target?: { name?: string };
  http?: {
    req?: { headers?: Record<string, string>; originalUrl?: string };
    res?: { setHeader: jest.Mock; status: jest.Mock; json: jest.Mock; headersSent?: boolean };
  };
  reject: jest.Mock;
  payment?: unknown;
}

function fakeService() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: ((req: any) => unknown) | null = null;
  const srv = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    before: jest.fn((_evt: string | string[], handler: (req: any) => unknown) => {
      captured = handler;
    }),
  };
  return {
    srv,
    invoke: (req: CapturedReq) => {
      if (!captured) throw new Error('handler was not registered');
      return captured(req);
    },
  };
}

/**
 * Build a fake cds.Request. Pass either:
 *   - an action call:  makeReq({ event: 'getBestPrice' })
 *   - a CRUD call:     makeReq({ event: 'READ', entity: 'Prices' })
 *
 * `entity` is the unqualified segment that routePricing keys against
 * (CAP exposes it as `req.target.name === 'Svc.Entity'`, the gate
 * splits and takes the last segment).
 */
function makeReq(opts: { event: string; entity?: string; headers?: Record<string, string> }): CapturedReq {
  const target = opts.entity ? { name: `PricesService.${opts.entity}` } : undefined;
  // status/json are chainable in Express; return the same res mock from
  // status() so `res.status(402).json(body)` works.
  const res = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn(), headersSent: false };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return {
    event: opts.event,
    ...(target ? { target } : {}),
    http: {
      req: { headers: opts.headers ?? {}, originalUrl: `/odata/v4/svc/${opts.entity ?? opts.event}` },
      res,
    },
    // In real CAP this throws synchronously to abort the handler chain; in
    // the tests we model it as a jest mock so we can assert on calls. The
    // gate's code path is identical either way (it makes the call and returns).
    reject: jest.fn(),
  };
}

function makeReqNoHttp(opts: { event: string }): CapturedReq {
  return { event: opts.event, reject: jest.fn() };
}

beforeEach(() => { jest.resetAllMocks(); });

describe('gateService, argument validation', () => {
  const { srv } = fakeService();
  it('throws when payTo missing', () => {
    expect(() => gateService(srv as never, { network: NETWORK_PREPROD, asset: 'lovelace', priceUnits: 1 } as never))
      .toThrow(/payTo/);
  });
  it('throws when network missing', () => {
    expect(() => gateService(srv as never, { payTo: SELLER_ADDR, asset: 'lovelace', priceUnits: 1 } as never))
      .toThrow(/network/);
  });
  it('throws when asset missing', () => {
    expect(() => gateService(srv as never, { payTo: SELLER_ADDR, network: NETWORK_PREPROD, priceUnits: 1 } as never))
      .toThrow(/asset/);
  });
  it('throws when neither priceUnits nor routePricing', () => {
    expect(() => gateService(srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
    } as never)).toThrow(/priceUnits or routePricing/);
  });
});

describe('gateService, bypass behaviour', () => {
  it('passes through events absent from routePricing (no priceUnits fallback)', async () => {
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: { getBestPrice: '10000' },
    });
    const req = makeReq({ event: 'getFree' });
    await f.invoke(req);
    expect(req.reject).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('falls back to priceUnits when routePricing key missing and priceUnits set', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '5000',
      routePricing: { getBestPrice: '10000' },
    });
    const req = makeReq({ event: 'someOtherAction' });
    await f.invoke(req);
    expect(mockProcess).toHaveBeenCalledTimes(1);
    const call = mockProcess.mock.calls[0]![0] as { requirementsBody: { accepts: Array<{ amount: string }> } };
    expect(call.requirementsBody.accepts[0]!.amount).toBe('5000');
  });
});

describe('gateService, dynamic pricing (routePricing as function)', () => {
  function stubAccepts() {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
  }

  it('invokes resolver with PricingContext including event + target', async () => {
    stubAccepts();
    const resolver = jest.fn(() => '9000');
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: resolver,
    });
    await f.invoke(makeReq({ event: 'READ', entity: 'Quotes', headers: { 'x-tier': 'gold' } }));
    expect(resolver).toHaveBeenCalledTimes(1);
    const ctx = resolver.mock.calls[0]![0] as { event: string; target?: string; headers: Record<string, string> };
    expect(ctx.event).toBe('READ');
    expect(ctx.target).toBe('PricesService.Quotes');
    expect(ctx.headers['x-tier']).toBe('gold');

    const call = mockProcess.mock.calls[0]![0] as { requirementsBody: { accepts: Array<{ amount: string }> } };
    expect(call.requirementsBody.accepts[0]!.amount).toBe('9000');
  });

  it('returning null = pass-through (no facilitator call, no reject)', async () => {
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: () => null,
    });
    const req = makeReq({ event: 'anyAction' });
    await f.invoke(req);
    expect(req.reject).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('rejects with 500 when resolver throws', async () => {
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: () => { throw new Error('pricing DB down'); },
    });
    const req = makeReq({ event: 'foo' });
    await f.invoke(req);
    expect(req.reject).toHaveBeenCalledWith(500, expect.stringContaining('pricing'));
    expect(mockProcess).not.toHaveBeenCalled();
  });
});

describe('gateService, 402 paths', () => {
  it('writes the canonical v2 body to httpRes (not the OData-wrapped shape)', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: { getBestPrice: '10000' },
    });
    const req = makeReq({ event: 'getBestPrice' });
    await f.invoke(req);
    // Direct-write path: v2 body lands at the top level on the wire.
    expect(req.http!.res!.status).toHaveBeenCalledWith(402);
    const wireBody = req.http!.res!.json.mock.calls[0]![0] as { x402Version: number; accepts: unknown };
    expect(wireBody.x402Version).toBe(2);
    expect(wireBody.accepts).toBeDefined();
    // req.reject is still invoked: its throw terminates CAP's handler
    // chain, the render attempt no-ops on headersSent.
    expect(req.reject).toHaveBeenCalledTimes(1);
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
  });

  it('rejects with status 402 + pending markers on pending', async () => {
    mockProcess.mockResolvedValue({
      kind: 'pending', code: Codes.PENDING, reason: 'not visible',
      txHash: 'ab'.repeat(32),
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: { Prices: '10000' },
    });
    const req = makeReq({ event: 'READ', entity: 'Prices' });
    await f.invoke(req);
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
    const wireBody = req.http!.res!.json.mock.calls[0]![0] as { pending: boolean; transaction: string };
    expect(wireBody.pending).toBe(true);
    expect(wireBody.transaction).toBe('ab'.repeat(32));
  });

  it('skips httpRes write when headersSent (defensive, falls back to req.reject)', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
    });
    const req = makeReq({ event: 'x' });
    req.http!.res!.headersSent = true;
    await f.invoke(req);
    expect(req.http!.res!.status).not.toHaveBeenCalled();
    expect(req.http!.res!.json).not.toHaveBeenCalled();
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
  });

  it('falls back to req.reject for non-HTTP transports (no http.res)', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
    });
    const req = makeReqNoHttp({ event: 'x' });
    await f.invoke(req);
    expect(req.reject).toHaveBeenCalledTimes(1);
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
    const body = JSON.parse(req.reject.mock.calls[0]![1]) as { x402Version: number };
    expect(body.x402Version).toBe(2);
  });
});

describe('gateService, accepted path', () => {
  it('stashes claim on req and sets X-PAYMENT-RESPONSE header', async () => {
    mockProcess.mockResolvedValue({
      kind: 'accepted',
      txHash: 'cd'.repeat(32),
      payment: { txHash: 'cd'.repeat(32), amountUnits: '1', network: NETWORK_PREPROD,
                 unit: '', asset: 'lovelace', resourceUrl: '/r', nonceRef: 'x#0' },
      paymentResponseB64: 'AAAA',
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: { Prices: '10000' },
    });
    const req = makeReq({ event: 'READ', entity: 'Prices' });
    await f.invoke(req);
    expect(req.reject).not.toHaveBeenCalled();
    expect(req.payment).toBeDefined();
    expect(req.http?.res?.setHeader).toHaveBeenCalledWith('X-PAYMENT-RESPONSE', 'AAAA');
  });
});

describe('gateService, internal error path', () => {
  it('rejects with status 500 when process throws', async () => {
    mockProcess.mockRejectedValue(new Error('boom'));
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
    });
    const req = makeReq({ event: 'any' });
    await f.invoke(req);
    expect(req.reject).toHaveBeenCalledWith(500, 'x402 internal error');
  });
});

describe('gateService, header lookup', () => {
  it('reads PAYMENT-SIGNATURE from req.http.req.headers', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
    });
    const req = makeReq({ event: 'any', headers: { 'payment-signature': 'abc123' } });
    await f.invoke(req);
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ paymentHeader: 'abc123' }));
  });
});

describe('gateService, custom resourceUrl', () => {
  it('uses the resourceUrl builder when provided', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      resourceUrl: (req) => `custom://${req.event}`,
    });
    await f.invoke(makeReq({ event: 'myAction' }));
    const call = mockProcess.mock.calls[0]![0] as { requirementsBody: { accepts: Array<{ resource: { url: string } }> } };
    expect(call.requirementsBody.accepts[0]!.resource.url).toBe('custom://myAction');
  });
});

describe('gateService, grants', () => {
  const ACCEPTED = {
    kind: 'accepted',
    txHash: 'cd'.repeat(32),
    payment: {
      txHash: 'cd'.repeat(32),
      amountUnits: '1',
      network: NETWORK_PREPROD,
      unit: '',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      resourceUrl: '/r',
      nonceRef: 'x#0',
    },
    paymentResponseB64: 'AAAA',
  };

  it('valid grant header bypasses 402 entirely', async () => {
    mockLookupGrant.mockResolvedValue({ kind: 'valid' });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      grants: true,
    });
    const req = makeReq({ event: 'something', headers: { 'x-payment-grant': 'tok-abc' } });
    await f.invoke(req);
    expect(mockProcess).not.toHaveBeenCalled();
    expect(req.reject).not.toHaveBeenCalled();
    expect(mockLookupGrant).toHaveBeenCalledWith(
      'odatano.x402.X402Grants', 'tok-abc', expect.any(String),
    );
  });

  it('expired grant falls through to the normal payment path', async () => {
    mockLookupGrant.mockResolvedValue({ kind: 'expired' });
    mockProcess.mockResolvedValue({
      kind: 'rejected', code: Codes.MISSING_HEADER, reason: '',
      requirementsBody: { x402Version: 2, error: 'X', accepts: [] },
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      grants: true,
    });
    const req = makeReq({ event: 'x', headers: { 'x-payment-grant': 'old-token' } });
    await f.invoke(req);
    expect(mockProcess).toHaveBeenCalledTimes(1); // payment path ran
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
  });

  it('issues a grant on accepted payment and sets X-PAYMENT-GRANT response header', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    mockIssueGrant.mockResolvedValue({
      token: 'new-tok-xyz',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      grants: { ttlSeconds: 7200 },
    });
    const req = makeReq({ event: 'getThing' });
    await f.invoke(req);

    expect(mockIssueGrant).toHaveBeenCalledTimes(1);
    const [entity, claim, route, ttl] = mockIssueGrant.mock.calls[0]!;
    expect(entity).toBe('odatano.x402.X402Grants');
    expect(claim.txHash).toBe(ACCEPTED.payment.txHash);
    expect(route).toBe('/odata/v4/svc/getThing');
    expect(ttl).toBe(7200);

    expect(req.http?.res?.setHeader).toHaveBeenCalledWith('X-PAYMENT-GRANT', 'new-tok-xyz');
    expect(req.http?.res?.setHeader).toHaveBeenCalledWith('X-PAYMENT-GRANT-EXPIRES', '2099-01-01T00:00:00.000Z');
  });

  it('does NOT set grant headers when issueGrant returns null (DB failure)', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    mockIssueGrant.mockResolvedValue(null);
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      grants: true,
    });
    const req = makeReq({ event: 'x' });
    await f.invoke(req);
    // X-PAYMENT-RESPONSE still set, X-PAYMENT-GRANT NOT set.
    const headerCalls = req.http?.res?.setHeader.mock.calls.map((c) => c[0]) ?? [];
    expect(headerCalls).toContain('X-PAYMENT-RESPONSE');
    expect(headerCalls).not.toContain('X-PAYMENT-GRANT');
  });

  it('does NOT call lookup or issue when grants option absent', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
    });
    await f.invoke(makeReq({ event: 'x', headers: { 'x-payment-grant': 'ignored' } }));
    expect(mockLookupGrant).not.toHaveBeenCalled();
    expect(mockIssueGrant).not.toHaveBeenCalled();
  });
});

describe('gateService, receipts persistence', () => {
  const ACCEPTED = {
    kind: 'accepted',
    txHash: 'cd'.repeat(32),
    payment: {
      txHash: 'cd'.repeat(32),
      amountUnits: '1',
      network: NETWORK_PREPROD,
      unit: '',
      asset: 'lovelace',
      payTo: SELLER_ADDR,
      resourceUrl: '/r',
      nonceRef: 'x#0',
    },
    paymentResponseB64: 'AAAA',
  };

  /**
   * Call the captured onAccepted that gateService passed to the
   * facilitator. We need this because mockProcess never actually runs
   * the pipeline, so we have to invoke onAccepted ourselves to exercise
   * the receipts path.
   */
  async function fireOnAccepted() {
    const args = mockProcess.mock.calls[0]![0] as { onAccepted?: (c: typeof ACCEPTED.payment) => Promise<void> };
    if (args.onAccepted) await args.onAccepted(ACCEPTED.payment);
  }

  it('persists a receipt to the default entity when receipts: true', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      receipts: true,
    });
    const req = makeReq({ event: 'getThing' });
    await f.invoke(req);
    await fireOnAccepted();

    expect(mockPersistReceipt).toHaveBeenCalledTimes(1);
    const [entityName, claim, route] = mockPersistReceipt.mock.calls[0]!;
    expect(entityName).toBe('odatano.x402.X402Receipts');
    expect(claim.txHash).toBe(ACCEPTED.payment.txHash);
    expect(route).toBe('/odata/v4/svc/getThing');
  });

  it('uses a custom entity name when receipts: { entity }', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      receipts: { entity: 'my.ns.MyReceipts' },
    });
    await f.invoke(makeReq({ event: 'x' }));
    await fireOnAccepted();
    expect(mockPersistReceipt.mock.calls[0]![0]).toBe('my.ns.MyReceipts');
  });

  it('skips receipts entirely when option absent', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      // no receipts option
    });
    await f.invoke(makeReq({ event: 'x' }));
    // onAccepted may not even be set on processArgs if neither receipts
    // nor user-onAccepted is configured. Either way, persistReceipt
    // never runs.
    await fireOnAccepted();
    expect(mockPersistReceipt).not.toHaveBeenCalled();
  });

  it('chains receipts before the user-supplied onAccepted', async () => {
    mockProcess.mockResolvedValue(ACCEPTED);
    const order: string[] = [];
    mockPersistReceipt.mockImplementation(async () => { order.push('persist'); });
    const onAccepted = jest.fn(async () => { order.push('user'); });

    const f = fakeService();
    gateService(f.srv as never, {
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      priceUnits: '1',
      receipts: true,
      onAccepted,
    });
    await f.invoke(makeReq({ event: 'x' }));
    await fireOnAccepted();

    expect(order).toEqual(['persist', 'user']);
  });
});
