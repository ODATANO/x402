/**
 * createFacilitatorRouter on a real express app, called through
 * httpFacilitator and plain fetch. The facilitator behind it is a mock.
 */

import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { createFacilitatorRouter, type CreateFacilitatorRouterOptions } from '../../srv/facilitator/server';
import { httpFacilitator } from '../../srv/facilitator/http';
import { buildRequirements } from '../../srv/core/requirements';
import { SELLER_ADDR, NETWORK_PREPROD, NONCE_REF } from '../fixtures/constants';
import type { Facilitator } from '../../srv/facilitator/adapter';
import type { PaymentPayload, PaymentRequirements, SettlementResponse, VerifyResponse } from '../../srv/core/types';
import type { SupportedResponse } from '../../srv/facilitator/adapter';

const req = buildRequirements({ amount: 2_000_000n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });
const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: 'AAAA', nonce: NONCE_REF } };
const SETTLED: SettlementResponse = { success: true, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD };

function mockFacilitator(withSupported = true): jest.Mocked<Facilitator> {
  return {
    verify: jest.fn<Promise<VerifyResponse>, [PaymentPayload, PaymentRequirements]>(async () => ({ isValid: true, payer: 'addr_test1payer' })),
    settle: jest.fn<Promise<SettlementResponse>, [PaymentPayload, PaymentRequirements]>(async () => SETTLED),
    ...(withSupported
      ? { supported: jest.fn<Promise<SupportedResponse>, []>(async () => ({ kinds: [], extensions: [], signers: {} })) }
      : {}),
  };
}

const silent = { warn: jest.fn(), error: jest.fn() };

async function boot(opts: CreateFacilitatorRouterOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createFacilitatorRouter({ logger: silent, ...opts }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

describe('createFacilitatorRouter', () => {
  it('serves /verify and /settle in the spec shape', async () => {
    const facilitator = mockFacilitator();
    const { url, close } = await boot({ facilitator });
    try {
      const client = httpFacilitator({ url });
      expect(await client.verify(payload, req)).toEqual({ isValid: true, payer: 'addr_test1payer' });
      expect(await client.settle(payload, req)).toEqual(SETTLED);
      expect(facilitator.verify).toHaveBeenCalledWith(payload, req);
      expect(facilitator.settle).toHaveBeenCalledWith(payload, req);
    } finally {
      await close();
    }
  });

  it('answers 400 for a body without x402Version, paymentPayload and paymentRequirements', async () => {
    const { url, close } = await boot({ facilitator: mockFacilitator() });
    try {
      for (const body of [{}, { x402Version: 1, paymentPayload: payload, paymentRequirements: req }, { x402Version: 2, paymentPayload: payload }]) {
        const res = await fetch(`${url}/settle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        expect(res.status).toBe(400);
      }
    } finally {
      await close();
    }
  });

  it('answers 500 when the facilitator throws', async () => {
    const facilitator = mockFacilitator();
    facilitator.verify.mockRejectedValue(new Error('boom'));
    const { url, close } = await boot({ facilitator });
    try {
      await expect(httpFacilitator({ url }).verify(payload, req)).rejects.toThrow(/returned 500/);
    } finally {
      await close();
    }
  });

  it('gates with auth: 401 on false, 500 on throw, healthz stays open', async () => {
    const auth = jest.fn<boolean, [express.Request]>().mockReturnValue(false);
    const { url, close } = await boot({ facilitator: mockFacilitator(), auth });
    try {
      expect((await fetch(`${url}/supported`)).status).toBe(401);
      auth.mockImplementation(() => { throw new Error('auth down'); });
      expect((await fetch(`${url}/supported`)).status).toBe(500);
      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      auth.mockReturnValue(true);
      expect((await fetch(`${url}/supported`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('fires onSettle after the response, and a failing hook does not break it', async () => {
    let resolveHook!: (r: SettlementResponse) => void;
    const seen = new Promise<SettlementResponse>(r => { resolveHook = r; });
    const onSettle = jest.fn(async (r: SettlementResponse) => { resolveHook(r); throw new Error('audit down'); });
    const { url, close } = await boot({ facilitator: mockFacilitator(), onSettle });
    try {
      expect(await httpFacilitator({ url }).settle(payload, req)).toEqual(SETTLED);
      expect(await seen).toEqual(SETTLED);
    } finally {
      await close();
    }
  });

  it('serves /supported, or 501 when the facilitator has none', async () => {
    const withS = await boot({ facilitator: mockFacilitator() });
    try {
      expect(await httpFacilitator({ url: withS.url }).supported!()).toEqual({ kinds: [], extensions: [], signers: {} });
    } finally {
      await withS.close();
    }
    const without = await boot({ facilitator: mockFacilitator(false) });
    try {
      expect((await fetch(`${without.url}/supported`)).status).toBe(501);
    } finally {
      await without.close();
    }
  });
});
