/**
 * Round-trip tests for `createFacilitatorRouter()`.
 *
 * We boot a real express app on a random ephemeral port and call it via
 * `httpFacilitator()`. That proves wire-compat against our own client
 * with zero translation layer, the same shape we document in
 * `docs/facilitator-protocol.md` is what both sides actually exchange.
 *
 * The underlying `Facilitator` is mocked, no chain calls, no @odatano/core
 * dependency exercised. Tests cover:
 *   - accepted / rejected / pending round-trip
 *   - auth hook accept + reject (401)
 *   - body too large (413)
 *   - missing requirementsBody (400)
 *   - GET /supported
 *   - GET /supported when facilitator omits supported() (501)
 *   - GET /healthz bypasses auth
 *   - onRejected / onPending audit hooks
 */

import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { createFacilitatorRouter } from '../../srv/facilitator/server';
import { httpFacilitator } from '../../srv/facilitator/http';
import type {
  Facilitator,
  FacilitatorResult,
  FacilitatorVerifyAndSettleArgs,
} from '../../srv/facilitator/adapter';
import type {
  PaymentRequirementsBody,
  PaymentClaim,
} from '../../srv/core/types';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';

const REQS: PaymentRequirementsBody = {
  x402Version: 2,
  accepts: [{
    scheme:              'exact',
    network:             NETWORK_PREPROD,
    asset:               'lovelace',
    amount:              '1000000',
    payTo:               SELLER_ADDR,
    resource:            { url: '/foo', description: '', mimeType: 'application/json' },
    assetTransferMethod: 'default',
    maxTimeoutSeconds:   600,
  }],
};

const ACCEPTED_CLAIM: PaymentClaim = {
  txHash:      'a'.repeat(64),
  amountUnits: '1000000',
  network:     NETWORK_PREPROD,
  unit:        '',
  asset:       'lovelace',
  payTo:       SELLER_ADDR,
  resourceUrl: '/foo',
  nonceRef:    'd'.repeat(64) + '#0',
};

function mockFacilitator(
  verify: (args: FacilitatorVerifyAndSettleArgs) => Promise<FacilitatorResult>,
  supported?: Facilitator['supported'],
): Facilitator {
  const fac: Facilitator = { verifyAndSettle: verify };
  if (supported !== undefined) fac.supported = supported;
  return fac;
}

async function bootApp(
  router: ReturnType<typeof createFacilitatorRouter>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(router);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}

describe('createFacilitatorRouter', () => {
  it('round-trips an accepted result via httpFacilitator', async () => {
    const verifyMock = jest.fn(async (): Promise<FacilitatorResult> => ({
      kind:               'accepted',
      txHash:             ACCEPTED_CLAIM.txHash,
      payment:            ACCEPTED_CLAIM,
      paymentResponseB64: Buffer.from('{"ok":true}').toString('base64'),
    }));
    const router = createFacilitatorRouter({ facilitator: mockFacilitator(verifyMock) });
    const { url, close } = await bootApp(router);

    try {
      const client = httpFacilitator({ url });
      const onAccepted = jest.fn();
      const r = await client.verifyAndSettle({
        paymentHeader:    'AAA',
        requirementsBody: REQS,
        onAccepted,
      });

      expect(r.kind).toBe('accepted');
      if (r.kind === 'accepted') {
        expect(r.payment.txHash).toBe(ACCEPTED_CLAIM.txHash);
      }
      expect(onAccepted).toHaveBeenCalledTimes(1); // client invokes locally

      // Server-side: onAccepted is NEVER forwarded over the wire.
      const args = verifyMock.mock.calls[0]![0];
      expect(args.paymentHeader).toBe('AAA');
      expect(args.requirementsBody).toEqual(REQS);
      expect((args as { onAccepted?: unknown }).onAccepted).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('round-trips a rejected result and invokes onRejected after the response', async () => {
    const verifyMock = jest.fn(async (): Promise<FacilitatorResult> => ({
      kind:             'rejected',
      code:             'wrong_recipient',
      reason:           'no output paid to addr_test1...',
      requirementsBody: REQS,
    }));
    const onRejected = jest.fn();
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(verifyMock),
      onRejected,
    });
    const { url, close } = await bootApp(router);

    try {
      const client = httpFacilitator({ url });
      const r = await client.verifyAndSettle({
        paymentHeader: 'AAA', requirementsBody: REQS,
      });
      expect(r.kind).toBe('rejected');

      // Hook is fired AFTER the response, give the event loop a tick.
      await new Promise((r) => setImmediate(r));
      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(onRejected.mock.calls[0]![0].code).toBe('wrong_recipient');
    } finally {
      await close();
    }
  });

  it('round-trips a pending result and invokes onPending', async () => {
    const verifyMock = jest.fn(async (): Promise<FacilitatorResult> => ({
      kind:             'pending',
      code:             'invalid_transaction_state',
      txHash:           'b'.repeat(64),
      reason:           'tx submitted, not yet on chain',
      requirementsBody: REQS,
    }));
    const onPending = jest.fn();
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(verifyMock),
      onPending,
    });
    const { url, close } = await bootApp(router);

    try {
      const client = httpFacilitator({ url });
      const r = await client.verifyAndSettle({
        paymentHeader: 'AAA', requirementsBody: REQS,
      });
      expect(r.kind).toBe('pending');
      if (r.kind === 'pending') expect(r.txHash).toBe('b'.repeat(64));

      await new Promise((r) => setImmediate(r));
      expect(onPending).toHaveBeenCalledTimes(1);
    } finally {
      await close();
    }
  });

  it('rejects unauthenticated requests with 401 when auth returns false', async () => {
    const verifyMock = jest.fn();
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(verifyMock as never),
      auth: (req) => req.headers.authorization === 'Bearer good',
    });
    const { url, close } = await bootApp(router);

    try {
      // Wrong token: httpFacilitator throws on non-2xx.
      const badClient = httpFacilitator({ url, apiKey: 'bad' });
      await expect(
        badClient.verifyAndSettle({ paymentHeader: 'A', requirementsBody: REQS }),
      ).rejects.toThrow(/401/);
      expect(verifyMock).not.toHaveBeenCalled(); // never reaches facilitator
    } finally {
      await close();
    }
  });

  it('accepts authenticated requests when auth returns true', async () => {
    const verifyMock = jest.fn(async (): Promise<FacilitatorResult> => ({
      kind:               'accepted',
      txHash:             ACCEPTED_CLAIM.txHash,
      payment:            ACCEPTED_CLAIM,
      paymentResponseB64: 'xx',
    }));
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(verifyMock),
      auth: (req) => req.headers.authorization === 'Bearer good',
    });
    const { url, close } = await bootApp(router);

    try {
      const goodClient = httpFacilitator({ url, apiKey: 'good' });
      const r = await goodClient.verifyAndSettle({
        paymentHeader: 'A', requirementsBody: REQS,
      });
      expect(r.kind).toBe('accepted');
    } finally {
      await close();
    }
  });

  it('rejects oversized payloads (jsonLimit)', async () => {
    const verifyMock = jest.fn();
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(verifyMock as never),
      jsonLimit:   '1kb',
    });
    const { url, close } = await bootApp(router);

    try {
      // Build a 2 kB payload by stuffing a long paymentHeader.
      const huge = 'A'.repeat(2048);
      const res = await fetch(`${url}/verify-settle`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ paymentHeader: huge, requirementsBody: REQS }),
      });
      expect(res.status).toBe(413);
      expect(verifyMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('returns 400 when requirementsBody is missing', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(jest.fn() as never),
    });
    const { url, close } = await bootApp(router);

    try {
      const res = await fetch(`${url}/verify-settle`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ paymentHeader: 'A' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('GET /supported returns the facilitator capabilities', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(
        jest.fn() as never,
        async () => ({
          networks:             ['cardano:preprod', 'cardano:mainnet'],
          assetTransferMethods: ['default'],
        }),
      ),
    });
    const { url, close } = await bootApp(router);

    try {
      const client = httpFacilitator({ url });
      const s = await client.supported!();
      expect(s.networks).toContain('cardano:preprod');
      expect(s.assetTransferMethods).toEqual(['default']);
    } finally {
      await close();
    }
  });

  it('GET /supported returns 501 when facilitator omits supported()', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(jest.fn() as never), // no supported
    });
    const { url, close } = await bootApp(router);

    try {
      const res = await fetch(`${url}/supported`);
      expect(res.status).toBe(501);
    } finally {
      await close();
    }
  });

  it('GET /healthz is open and returns ok:true even with auth configured', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(jest.fn() as never),
      auth:        () => false, // would reject everything else
    });
    const { url, close } = await bootApp(router);

    try {
      const res = await fetch(`${url}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    } finally {
      await close();
    }
  });

  it('returns 500 when the facilitator throws', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(async () => { throw new Error('bridge down'); }),
      logger:      { warn: () => {}, error: () => {} }, // silence expected error log
    });
    const { url, close } = await bootApp(router);

    try {
      const res = await fetch(`${url}/verify-settle`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ paymentHeader: 'A', requirementsBody: REQS }),
      });
      expect(res.status).toBe(500);
    } finally {
      await close();
    }
  });

  it('returns 500 when the auth hook throws', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(jest.fn() as never),
      auth: () => { throw new Error('jwks unreachable'); },
      logger: { warn: () => {}, error: () => {} },
    });
    const { url, close } = await bootApp(router);
    try {
      const res = await fetch(`${url}/verify-settle`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        body:    JSON.stringify({ paymentHeader: 'A', requirementsBody: REQS }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/auth check failed/);
    } finally {
      await close();
    }
  });

  it('returns 500 when supported() throws', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(
        jest.fn() as never,
        async () => { throw new Error('upstream down'); },
      ),
      logger: { warn: () => {}, error: () => {} },
    });
    const { url, close } = await bootApp(router);
    try {
      const res = await fetch(`${url}/supported`);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/upstream down/);
    } finally {
      await close();
    }
  });

  it('swallows onRejected hook errors', async () => {
    const router = createFacilitatorRouter({
      facilitator: mockFacilitator(async () => ({
        kind: 'rejected', code: 'wrong_recipient', reason: 'x', requirementsBody: REQS,
      })),
      onRejected: () => { throw new Error('audit DB down'); },
      logger:     { warn: () => {}, error: () => {} },
    });
    const { url, close } = await bootApp(router);

    try {
      const client = httpFacilitator({ url });
      const r = await client.verifyAndSettle({
        paymentHeader: 'A', requirementsBody: REQS,
      });
      expect(r.kind).toBe('rejected'); // never propagates
      await new Promise((r) => setImmediate(r));
    } finally {
      await close();
    }
  });
});
