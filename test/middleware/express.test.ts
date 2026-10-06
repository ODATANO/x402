/**
 * Express middleware against a real HTTP server, so the response holding
 * (`writeHead`, `write`, `end` capture until settlement) runs for real.
 * The facilitator is a fake; payment headers carry real signed transactions.
 */

// decodePayment runs through srv/bridge → @odatano/core; stub the barrel to its pure parser.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

const mockDefaultFacilitator = jest.fn();
jest.mock('../../srv/facilitator/adapter', () => ({
  defaultFacilitator: () => mockDefaultFacilitator(),
}));

import express, { type Request } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { x402Middleware, type X402MiddlewareOptions } from '../../srv/middleware/express';
import { paymentRequiredFor } from '../../srv/middleware/flow';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_ADDR, BUYER_PRIV, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  NETWORK_PREPROD, TTL_SLOT,
} from '../fixtures/constants';
import { buildBody, signTx } from '../fixtures/build-tx';
import { buildPaymentSignature, decodeHeader } from '../fixtures/envelope';
import type { Facilitator } from '../../srv/facilitator/adapter';
import type {
  PaymentClaim,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from '../../srv/core/types';

const baseOpts = {
  payTo: SELLER_ADDR,
  network: NETWORK_PREPROD,
  asset: 'lovelace',
  priceUnits: '1000000',
};

const SETTLED: SettlementResponse = {
  success: true, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD, payer: BUYER_ADDR, amount: '1000000',
};

function fakeFacilitator() {
  return {
    verify: jest.fn<Promise<VerifyResponse>, [PaymentPayload, PaymentRequirements]>()
      .mockResolvedValue({ isValid: true, payer: BUYER_ADDR }),
    settle: jest.fn<Promise<SettlementResponse>, [PaymentPayload, PaymentRequirements]>()
      .mockResolvedValue(SETTLED),
  } satisfies Facilitator;
}

function paymentHeader(): string {
  const accepted = paymentRequiredFor(baseOpts, [{ amount: '1000000' }], '/').accepts[0]!;
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    ttlSlot: TTL_SLOT,
  });
  return buildPaymentSignature({ accepted, txCborHex: signTx(body, [BUYER_PRIV]).cborHex, nonceRef: NONCE_REF });
}

interface Running { url: string; close: () => Promise<void> }

/** Headers the `/api/csv` handler sets itself. */
const HANDLER_HEADERS = {
  'Content-Type':        'text/csv; charset=utf-8',
  'Set-Cookie':          'session=abc; Path=/',
  'Cache-Control':       'public, max-age=3600',
  'Content-Disposition': 'attachment; filename="quotes.csv"',
  'ETag':                'W/"handler-etag"',
};

/** Serve `/api/*` behind the middleware with handlers covering every response style. */
async function serve(opts: Partial<X402MiddlewareOptions>): Promise<Running> {
  const app = express();
  // set before the gate runs, as a request-id middleware would
  app.use((_req, res, next) => { res.setHeader('X-Request-Id', 'req-1'); next(); });
  app.use('/api', x402Middleware({ ...baseOpts, ...opts }));
  app.get('/api/csv', (_req, res) => { res.set(HANDLER_HEADERS).send('a;b\n1;2\n'); });
  app.get('/api/json', (req: Request, res) => { res.json({ ok: true, payment: req.payment }); });
  app.get('/api/send', (_req, res) => { res.send('hello'); });
  app.get('/api/stream', (_req, res) => { res.write('a'); res.write('b'); res.end('c'); });
  app.get('/api/head', (_req, res) => { res.writeHead(201, { 'X-Custom': '1' }); res.end('made'); });
  app.get('/api/short', (_req, res) => { res.send('x'); });
  app.get('/api/fail', (_req, res) => { res.status(500).json({ error: 'boom' }); });
  app.get('/api/throw', () => { throw new Error('handler threw'); });
  app.get('/api/\\$metadata', (_req, res) => { res.send('metadata'); });
  const server: Server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(() => r())),
  };
}

let running: Running | undefined;
beforeEach(() => { mockDefaultFacilitator.mockReset(); });
afterEach(async () => { await running?.close(); running = undefined; });

async function paidGet(path: string, opts: Partial<X402MiddlewareOptions>) {
  running = await serve(opts);
  return fetch(`${running.url}${path}`, { headers: { 'PAYMENT-SIGNATURE': paymentHeader() } });
}

describe('x402Middleware, argument validation', () => {
  it.each(['payTo', 'network', 'asset'] as const)('throws without %s', (field) => {
    expect(() => x402Middleware({ ...baseOpts, [field]: '' })).toThrow(field);
  });
  it('throws without priceUnits or routePricing', () => {
    expect(() => x402Middleware({ payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace' }))
      .toThrow(/priceUnits or routePricing/);
  });
});

describe('x402Middleware, default facilitator', () => {
  it('uses the process-wide default when none is passed', async () => {
    const shared = fakeFacilitator();
    mockDefaultFacilitator.mockReturnValue(shared);
    x402Middleware(baseOpts);
    const res = await paidGet('/api/send', {});
    expect(mockDefaultFacilitator).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(shared.verify).toHaveBeenCalledTimes(1);
    expect(shared.settle).toHaveBeenCalledTimes(1);
  });

  it('does not ask for the default when a facilitator is passed', () => {
    x402Middleware({ ...baseOpts, facilitator: fakeFacilitator() });
    expect(mockDefaultFacilitator).not.toHaveBeenCalled();
  });
});

describe('x402Middleware, unpaid requests', () => {
  it('answers 402 with PAYMENT-REQUIRED and the resource URL', async () => {
    const facilitator = fakeFacilitator();
    running = await serve({ facilitator });
    const res = await fetch(`${running.url}/api/json`);
    expect(res.status).toBe(402);
    const pr = decodeHeader<PaymentRequired>(res.headers.get('payment-required'));
    expect(pr.resource.url).toBe('/api/json');
    expect(pr.accepts[0]!.amount).toBe('1000000');
    expect(await res.json()).toEqual(pr);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed payment header', async () => {
    running = await serve({ facilitator: fakeFacilitator() });
    const res = await fetch(`${running.url}/api/json`, { headers: { 'PAYMENT-SIGNATURE': 'garbage!!' } });
    expect(res.status).toBe(400);
    expect(decodeHeader<PaymentRequired>(res.headers.get('payment-required')).error).toContain(Codes.INVALID_PAYLOAD);
  });

  it('passes skipped paths through unpaid', async () => {
    running = await serve({ facilitator: fakeFacilitator() });
    const res = await fetch(`${running.url}/api/$metadata`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('metadata');
  });

  it('passes through when the resolver returns null', async () => {
    running = await serve({ facilitator: fakeFacilitator(), priceUnits: undefined, routePricing: () => null });
    const res = await fetch(`${running.url}/api/send`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('answers 500 when the resolver throws', async () => {
    running = await serve({
      facilitator: fakeFacilitator(), priceUnits: undefined,
      routePricing: () => { throw new Error('pricing DB down'); },
    });
    const res = await fetch(`${running.url}/api/send`);
    expect(res.status).toBe(500);
  });

  it('prices by the URL segment without OData arguments', async () => {
    running = await serve({ facilitator: fakeFacilitator(), priceUnits: undefined, routePricing: { json: '7777' } });
    const res = await fetch(`${running.url}/api/json(pair='ADA')`);
    expect(decodeHeader<PaymentRequired>(res.headers.get('payment-required')).accepts[0]!.amount).toBe('7777');
  });
});

describe('x402Middleware, paid requests', () => {
  it('settles, then sends the handler body with PAYMENT-RESPONSE; req.payment is set for the handler', async () => {
    const facilitator = fakeFacilitator();
    const res = await paidGet('/api/json', { facilitator });
    expect(res.status).toBe(200);
    expect(decodeHeader(res.headers.get('payment-response'))).toEqual(SETTLED);
    const body = await res.json() as { ok: boolean; payment: PaymentClaim };
    expect(body.ok).toBe(true);
    expect(body.payment.payTo).toBe(SELLER_ADDR);
    expect(body.payment.payerAddr).toBe(BUYER_ADDR);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/api/send', 'hello'],
    ['/api/stream', 'abc'],
  ])('holds %s until settlement and delivers it whole', async (path, text) => {
    const res = await paidGet(path, { facilitator: fakeFacilitator() });
    expect(res.status).toBe(200);
    expect(res.headers.get('payment-response')).toBeTruthy();
    expect(await res.text()).toBe(text);
  });

  it('keeps a status and headers set via writeHead', async () => {
    const res = await paidGet('/api/head', { facilitator: fakeFacilitator() });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-custom')).toBe('1');
    expect(res.headers.get('payment-response')).toBeTruthy();
    expect(await res.text()).toBe('made');
  });

  it.each(['/api/fail', '/api/throw'])('does not settle when %s fails', async (path) => {
    const facilitator = fakeFacilitator();
    const res = await paidGet(path, { facilitator });
    expect(res.status).toBe(500);
    expect(res.headers.get('payment-response')).toBeNull();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('replaces the body with a 402 when settlement fails', async () => {
    const facilitator = fakeFacilitator();
    const failed: SettlementResponse = {
      success: false, errorReason: Codes.PENDING, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD,
    };
    facilitator.settle.mockResolvedValue(failed);
    const res = await paidGet('/api/short', { facilitator });
    expect(res.status).toBe(402);
    expect(decodeHeader(res.headers.get('payment-response'))).toEqual(failed);
    // Parses only if the stale Content-Length of the 1-byte body was dropped.
    const body = await res.json() as PaymentRequired;
    expect(body.error).toContain(Codes.PENDING);
    expect(decodeHeader<PaymentRequired>(res.headers.get('payment-required')).error).toBe(body.error);
  });

  it('answers 500 when settle throws', async () => {
    const facilitator = fakeFacilitator();
    facilitator.settle.mockRejectedValue(new Error('network down'));
    const res = await paidGet('/api/send', { facilitator });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'x402 settlement error' });
  });

  it('keeps the headers the handler set when settlement succeeds', async () => {
    const res = await paidGet('/api/csv', { facilitator: fakeFacilitator() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('set-cookie')).toBe('session=abc; Path=/');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="quotes.csv"');
    expect(res.headers.get('etag')).toBe('W/"handler-etag"');
    expect(res.headers.get('x-request-id')).toBe('req-1');
    expect(res.headers.get('payment-response')).toBeTruthy();
    expect(await res.text()).toBe('a;b\n1;2\n');
  });

  /** None of the handler's headers may describe the answer that replaced its response. */
  function expectHandlerHeadersGone(res: Response): void {
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBeNull();
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('etag')).not.toBe('W/"handler-etag"');
    expect(res.headers.get('x-request-id')).toBe('req-1');
  }

  it('drops every header the handler set when a failed settlement replaces the response', async () => {
    const facilitator = fakeFacilitator();
    const failed: SettlementResponse = {
      success: false, errorReason: Codes.SUBMIT_FAILED, transaction: '', network: NETWORK_PREPROD,
    };
    facilitator.settle.mockResolvedValue(failed);
    const res = await paidGet('/api/csv', { facilitator });
    expect(res.status).toBe(402);
    expectHandlerHeadersGone(res);
    expect(decodeHeader(res.headers.get('payment-response'))).toEqual(failed);
    const required = decodeHeader<PaymentRequired>(res.headers.get('payment-required'));
    expect(await res.json()).toEqual(required);
  });

  it('drops every header the handler set when settle throws', async () => {
    const facilitator = fakeFacilitator();
    facilitator.settle.mockRejectedValue(new Error('network down'));
    const res = await paidGet('/api/csv', { facilitator });
    expect(res.status).toBe(500);
    expectHandlerHeadersGone(res);
    expect(res.headers.get('payment-response')).toBeNull();
    expect(await res.json()).toEqual({ error: 'x402 settlement error' });
  });

  it('runs onAccepted after settlement with the claim and request', async () => {
    const facilitator = fakeFacilitator();
    const onAccepted = jest.fn();
    await paidGet('/api/send', { facilitator, onAccepted });
    expect(onAccepted).toHaveBeenCalledTimes(1);
    const [claim, req] = onAccepted.mock.calls[0]!;
    expect((claim as PaymentClaim).resourceUrl).toBe('/api/send');
    expect((req as Request).originalUrl).toBe('/api/send');
    expect(facilitator.settle.mock.invocationCallOrder[0]!).toBeLessThan(onAccepted.mock.invocationCallOrder[0]!);
  });

  it('still answers 200 when onAccepted throws', async () => {
    const res = await paidGet('/api/send', {
      facilitator: fakeFacilitator(),
      onAccepted: () => { throw new Error('audit DB down'); },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('answers 402 without running the handler when verify fails', async () => {
    const facilitator = fakeFacilitator();
    facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: Codes.REPLAY });
    const res = await paidGet('/api/json', { facilitator });
    expect(res.status).toBe(402);
    expect(decodeHeader<PaymentRequired>(res.headers.get('payment-required')).error).toContain(Codes.REPLAY);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('answers 500 when verify throws', async () => {
    const facilitator = fakeFacilitator();
    facilitator.verify.mockRejectedValue(new Error('facilitator unreachable'));
    const res = await paidGet('/api/json', { facilitator });
    expect(res.status).toBe(500);
  });
});
