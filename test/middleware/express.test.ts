/**
 * Express middleware tests. We don't spin up an actual HTTP server —
 * the middleware is just `(req, res, next) => Promise<void>`, so we
 * call it directly with hand-rolled req/res mocks and assert on the
 * side effects (status code, JSON body, headers, next() called).
 *
 * Both the bridge and the facilitator's `process` are mocked, so each
 * test pins exactly one outcome (accepted/rejected/pending).
 */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

const mockProcess = jest.fn();
jest.mock('../../srv/facilitator/verify', () => ({
  process: (...args: unknown[]) => mockProcess(...args),
}));

import { x402Middleware } from '../../srv/middleware/express';
import { Codes } from '../../srv/core/errors';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';
import type { Request, Response } from 'express';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): MockRes;
  json(b: unknown): MockRes;
  setHeader(k: string, v: string): void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
  return res;
}

function mockReq(opts: { path?: string; originalUrl?: string; headers?: Record<string, string> } = {}): Request {
  return {
    path: opts.path ?? '/foo',
    originalUrl: opts.originalUrl ?? '/foo',
    url: opts.originalUrl ?? '/foo',
    headers: opts.headers ?? {},
  } as unknown as Request;
}

const baseOpts = {
  payTo: SELLER_ADDR,
  network: NETWORK_PREPROD,
  asset: 'lovelace',
  priceUnits: '1000000',
};

beforeEach(() => { jest.resetAllMocks(); });

describe('x402Middleware — argument validation', () => {
  it('throws if payTo missing', () => {
    expect(() => x402Middleware({ ...baseOpts, payTo: '' as never })).toThrow(/payTo/);
  });
  it('throws if network missing', () => {
    expect(() => x402Middleware({ ...baseOpts, network: '' as never })).toThrow(/network/);
  });
  it('throws if asset missing', () => {
    expect(() => x402Middleware({ ...baseOpts, asset: '' as never })).toThrow(/asset/);
  });
  it('throws if neither priceUnits nor routePricing provided', () => {
    const opts = { payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace' };
    expect(() => x402Middleware(opts as never)).toThrow(/priceUnits or routePricing/);
  });
});

describe('x402Middleware — bypass paths', () => {
  it('passes through default-skipped OData $metadata', async () => {
    const mw = x402Middleware(baseOpts);
    const req = mockReq({ path: '/$metadata' });
    const res = mockRes();
    const next = jest.fn();
    await mw(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it('passes through root path', async () => {
    const mw = x402Middleware(baseOpts);
    const next = jest.fn();
    await mw(mockReq({ path: '/' }), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes through unmapped path under routePricing (no priceUnits fallback)', async () => {
    const mw = x402Middleware({
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: { getBestPrice: '10000' },
    });
    const next = jest.fn();
    await mw(mockReq({ path: '/getOhlcv' }), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });
});

describe('x402Middleware — pricing resolution', () => {
  it('strips OData function args from segment for routePricing lookup', async () => {
    mockProcess.mockResolvedValue({ kind: 'rejected', code: Codes.MISSING_HEADER, reason: 'r',
      requirementsBody: { x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', accepts: [] } });
    const mw = x402Middleware({
      payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace',
      routePricing: { getBestPrice: '7777' },
    });
    await mw(mockReq({ path: '/getBestPrice(pair=\'ADA-USD\')' }), mockRes() as unknown as Response, jest.fn());
    const call = mockProcess.mock.calls[0]![0] as { requirementsBody: { accepts: Array<{ amount: string }> } };
    expect(call.requirementsBody.accepts[0]!.amount).toBe('7777');
  });
});

describe('x402Middleware — 402 paths', () => {
  it('returns 402 with requirements body on missing header', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected',
      code: Codes.MISSING_HEADER,
      reason: 'X-…',
      requirementsBody: {
        x402Version: 2,
        error: 'PAYMENT-SIGNATURE header is required',
        accepts: [{ scheme: 'exact', network: NETWORK_PREPROD, asset: 'lovelace', amount: '1000000',
                    payTo: SELLER_ADDR, resource: { url: '/foo', description: '', mimeType: 'application/json' },
                    assetTransferMethod: 'default', maxTimeoutSeconds: 600 }],
      },
    });
    const mw = x402Middleware(baseOpts);
    const res = mockRes();
    await mw(mockReq(), res as unknown as Response, jest.fn());
    expect(res.statusCode).toBe(402);
    const body = res.body as { x402Version: number; error: string };
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe('PAYMENT-SIGNATURE header is required');
  });

  it('appends (code): reason to error when rejection is more specific than MISSING_HEADER', async () => {
    mockProcess.mockResolvedValue({
      kind: 'rejected',
      code: Codes.INSUFFICIENT_AMOUNT,
      reason: 'paid 500000 < required 1000000',
      requirementsBody: {
        x402Version: 2,
        error: 'PAYMENT-SIGNATURE header is required',
        accepts: [],
      },
    });
    const mw = x402Middleware(baseOpts);
    const res = mockRes();
    await mw(mockReq(), res as unknown as Response, jest.fn());
    const body = res.body as { error: string };
    expect(body.error).toMatch(/insufficient_amount/);
    expect(body.error).toMatch(/paid 500000/);
  });

  it('returns 402 with pending=true on pending result', async () => {
    mockProcess.mockResolvedValue({
      kind: 'pending',
      code: Codes.PENDING,
      reason: 'tx not visible',
      txHash: 'ab'.repeat(32),
      requirementsBody: { x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', accepts: [] },
    });
    const mw = x402Middleware(baseOpts);
    const res = mockRes();
    await mw(mockReq(), res as unknown as Response, jest.fn());
    const body = res.body as { pending: boolean; transaction: string };
    expect(res.statusCode).toBe(402);
    expect(body.pending).toBe(true);
    expect(body.transaction).toBe('ab'.repeat(32));
  });
});

describe('x402Middleware — accepted path', () => {
  it('sets X-PAYMENT-RESPONSE and calls next()', async () => {
    mockProcess.mockResolvedValue({
      kind: 'accepted',
      txHash: 'cd'.repeat(32),
      payment: { txHash: 'cd'.repeat(32), amountUnits: '1000000', network: NETWORK_PREPROD,
                 unit: '', asset: 'lovelace', resourceUrl: '/foo', nonceRef: 'x#0' },
      paymentResponseB64: 'eyJzdWNjZXNzIjp0cnVlfQ==',
    });
    const mw = x402Middleware(baseOpts);
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    await mw(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers['X-PAYMENT-RESPONSE']).toBe('eyJzdWNjZXNzIjp0cnVlfQ==');
    expect((req as unknown as { payment?: unknown }).payment).toBeDefined();
  });
});

describe('x402Middleware — internal errors', () => {
  it('calls next(err) when process throws unexpectedly', async () => {
    mockProcess.mockRejectedValue(new Error('boom'));
    const mw = x402Middleware(baseOpts);
    const next = jest.fn();
    await mw(mockReq(), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('x402Middleware — facilitator injection', () => {
  it('uses the injected facilitator instead of the default localFacilitator', async () => {
    // The module-level mock of `verify.process` would normally catch
    // the default path. A custom facilitator must bypass it entirely.
    const customVerifyAndSettle = jest.fn().mockResolvedValue({
      kind: 'rejected',
      code: 'wrong_recipient',
      reason: 'custom-fac saw nope',
      requirementsBody: { x402Version: 2, accepts: [] },
    });
    const mw = x402Middleware({
      ...baseOpts,
      facilitator: { verifyAndSettle: customVerifyAndSettle },
    });
    const next = jest.fn();
    const res = mockRes();
    await mw(mockReq({ headers: { 'payment-signature': 'AAA' } }), res as unknown as Response, next);

    expect(customVerifyAndSettle).toHaveBeenCalledTimes(1);
    expect(mockProcess).not.toHaveBeenCalled();       // default path skipped
    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });
});
