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

import { gateService } from '../../srv/middleware/cap';
import { Codes } from '../../srv/core/errors';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';

interface CapturedReq {
  event: string;
  target?: { name?: string };
  http?: { req?: { headers?: Record<string, string>; originalUrl?: string }; res?: { setHeader: jest.Mock } };
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
 * (CAP exposes it as `req.target.name === 'Svc.Entity'` — the gate
 * splits and takes the last segment).
 */
function makeReq(opts: { event: string; entity?: string; headers?: Record<string, string> }): CapturedReq {
  const target = opts.entity ? { name: `PricesService.${opts.entity}` } : undefined;
  return {
    event: opts.event,
    ...(target ? { target } : {}),
    http: {
      req: { headers: opts.headers ?? {}, originalUrl: `/odata/v4/svc/${opts.entity ?? opts.event}` },
      res: { setHeader: jest.fn() },
    },
    reject: jest.fn(),
  };
}

beforeEach(() => { jest.resetAllMocks(); });

describe('gateService — argument validation', () => {
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

describe('gateService — bypass behaviour', () => {
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

describe('gateService — 402 paths', () => {
  it('rejects with status 402 + JSON body on missing header', async () => {
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
    expect(req.reject).toHaveBeenCalledTimes(1);
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
    const body = JSON.parse(req.reject.mock.calls[0]![1]) as { x402Version: number };
    expect(body.x402Version).toBe(2);
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
    const body = JSON.parse(req.reject.mock.calls[0]![1]) as { pending: boolean; transaction: string };
    expect(body.pending).toBe(true);
    expect(body.transaction).toBe('ab'.repeat(32));
  });
});

describe('gateService — accepted path', () => {
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

describe('gateService — internal error path', () => {
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

describe('gateService — header lookup', () => {
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

describe('gateService — custom resourceUrl', () => {
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
