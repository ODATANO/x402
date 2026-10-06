/**
 * `x402Axios` against a minimal axios-shaped shim: it reproduces the
 * interceptor and request contract, which is all `x402Axios` touches.
 */

import { x402Axios } from '../../srv/client/axios';
import { X402PaymentError } from '../../srv/client/errors';
import { Codes } from '../../srv/core/errors';
import { decodeHeader, encodeRawPayload } from '../fixtures/envelope';
import { NETWORK_PREPROD, NONCE_REF, SELLER_ADDR } from '../fixtures/constants';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettlementResponse,
} from '../../srv/core/types';

const ACCEPTED: PaymentRequirements = {
  scheme: 'exact',
  network: NETWORK_PREPROD,
  asset: 'lovelace',
  amount: '1000000',
  payTo: SELLER_ADDR,
  maxTimeoutSeconds: 600,
};

const REQUIRED: PaymentRequired = {
  x402Version: 2,
  error: 'PAYMENT-SIGNATURE header is required',
  resource: { url: '/foo' },
  accepts: [ACCEPTED],
};

const PAID = { signedTxCborHex: 'cafe', nonceRef: NONCE_REF };
const pending: SettlementResponse = {
  success: false, errorReason: Codes.PENDING, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD,
};

interface Queued { status: number; headers?: unknown; data?: unknown }

/** Headers as axios exposes them: a plain object with lower-cased names. */
function lower(required: PaymentRequired | null = REQUIRED, settlement?: SettlementResponse): Record<string, string> {
  return {
    ...(required ? { 'payment-required': encodeRawPayload(required) } : {}),
    ...(settlement ? { 'payment-response': encodeRawPayload(settlement) } : {}),
  };
}

function makeShim(responses: Queued[]) {
  type Handler = (x: unknown) => unknown;
  let onFulfilled: Handler = (r) => r;
  let onRejected: Handler = (e) => { throw e; };
  const calls: Array<Record<string, unknown>> = [];

  const instance = {
    interceptors: {
      response: {
        use(f: Handler, r: Handler) { onFulfilled = f; onRejected = r; return 0; },
      },
    },
    async request(cfg: Record<string, unknown>) {
      calls.push(cfg);
      const next = responses.shift();
      if (!next) throw new Error('shim: ran out of queued responses');
      if (next.status >= 400) {
        const err = Object.assign(new Error(`HTTP ${next.status}`), {
          response: { status: next.status, headers: next.headers, data: next.data },
          config:   cfg,
        });
        return onRejected(err);
      }
      return onFulfilled({ status: next.status, data: next.data, config: cfg });
    },
  };
  return { instance, calls };
}

function signatureOf(cfg: Record<string, unknown> | undefined): string {
  return String((cfg?.headers as Record<string, unknown> | undefined)?.['PAYMENT-SIGNATURE']);
}

/** The rejection of a call expected to fail with `X402PaymentError`. */
async function rejection(p: Promise<unknown>): Promise<X402PaymentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof X402PaymentError) return e;
    throw e;
  }
  throw new Error('expected an X402PaymentError');
}

describe('x402Axios', () => {
  it('passes non-402 responses through', async () => {
    const { instance } = makeShim([{ status: 200, data: 'ok' }]);
    const pay = jest.fn();
    const res = await x402Axios(instance, { pay }).request({ url: '/foo' }) as { status: number };
    expect(res.status).toBe(200);
    expect(pay).not.toHaveBeenCalled();
  });

  it('rethrows non-402 errors', async () => {
    const { instance } = makeShim([{ status: 500 }]);
    await expect(x402Axios(instance, { pay: jest.fn() }).request({ url: '/foo' })).rejects.toThrow('HTTP 500');
  });

  it('pays from the lower-cased payment-required header and retries', async () => {
    const { instance, calls } = makeShim([{ status: 402, headers: lower() }, { status: 200, data: 'ok' }]);
    const pay = jest.fn(async () => PAID);
    const res = await x402Axios(instance, { pay }).request({ url: '/foo', headers: { 'x-a': '1' } }) as { status: number };

    expect(res.status).toBe(200);
    expect(pay).toHaveBeenCalledWith(ACCEPTED, REQUIRED);
    const payload = decodeHeader<PaymentPayload>(signatureOf(calls[1]));
    expect(payload.accepted).toEqual(ACCEPTED);
    expect(payload.resource).toEqual(REQUIRED.resource);
    expect((calls[1]!.headers as Record<string, unknown>)['x-a']).toBe('1');
  });

  it('reads headers through AxiosHeaders.get', async () => {
    const values = lower();
    const headers = { get: (name: string) => values[name.toLowerCase()] };
    const { instance } = makeShim([{ status: 402, headers }, { status: 200 }]);
    const pay = jest.fn(async () => PAID);
    await x402Axios(instance, { pay }).request({ url: '/foo' });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('treats a body-only 402 as invalid_payment_required', async () => {
    const { instance } = makeShim([{ status: 402, headers: {}, data: REQUIRED }]);
    const pay = jest.fn();
    await expect(x402Axios(instance, { pay, errorOnFailure: true }).request({ url: '/foo' }))
      .rejects.toMatchObject({ kind: 'invalid_payment_required' });
    expect(pay).not.toHaveBeenCalled();
  });

  it('rethrows the axios error for a body-only 402 without errorOnFailure', async () => {
    const { instance } = makeShim([{ status: 402, headers: {}, data: REQUIRED }]);
    await expect(x402Axios(instance, { pay: jest.fn() }).request({ url: '/foo' })).rejects.toThrow('HTTP 402');
  });

  it('re-sends the same header on settlement_pending without paying again', async () => {
    const { instance, calls } = makeShim([
      { status: 402, headers: lower() },
      { status: 402, headers: lower(REQUIRED, pending) },
      { status: 200 },
    ]);
    const pay = jest.fn(async () => PAID);
    const res = await x402Axios(instance, { pay, pendingRetryDelayMs: 0 }).request({ url: '/foo' }) as { status: number };

    expect(res.status).toBe(200);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(signatureOf(calls[2])).toBe(signatureOf(calls[1]));
  });

  it('throws settlement_pending once pendingRetries are used up', async () => {
    const { instance } = makeShim([
      { status: 402, headers: lower() },
      { status: 402, headers: lower(REQUIRED, pending) },
      { status: 402, headers: lower(REQUIRED, pending) },
    ]);
    const err = await rejection(x402Axios(instance, {
      pay: async () => PAID, pendingRetries: 1, pendingRetryDelayMs: 0, errorOnFailure: true,
    }).request({ url: '/foo' }));

    expect(err).toBeInstanceOf(X402PaymentError);
    expect(err.kind).toBe('settlement_pending');
    expect(err.settlement).toEqual(pending);
  });

  it('throws retries_exhausted after maxRetries payments', async () => {
    const { instance } = makeShim([{ status: 402, headers: lower() }, { status: 402, headers: lower() }]);
    const err = await rejection(x402Axios(instance, { pay: async () => PAID, errorOnFailure: true })
      .request({ url: '/foo' }));
    expect(err.kind).toBe('retries_exhausted');
  });

  it('throws server_rejected when no entry is selectable', async () => {
    const masumi = { ...REQUIRED, accepts: [{ ...ACCEPTED, extra: { assetTransferMethod: 'masumi' } }] };
    const { instance } = makeShim([{ status: 402, headers: lower(masumi as unknown as PaymentRequired) }]);
    await expect(x402Axios(instance, { pay: jest.fn(), errorOnFailure: true }).request({ url: '/foo' }))
      .rejects.toMatchObject({ kind: 'server_rejected' });
  });

  it('wraps pay handler errors', async () => {
    const { instance } = makeShim([{ status: 402, headers: lower() }]);
    const boom = new Error('no funds');
    const err = await rejection(x402Axios(instance, { pay: async () => { throw boom; } })
      .request({ url: '/foo' }));
    expect(err.kind).toBe('pay_handler_failed');
    expect(err.cause).toBe(boom);
  });

  it('rejects construction without a pay handler', () => {
    const { instance } = makeShim([]);
    expect(() => x402Axios(instance, {} as never)).toThrow(/opts.pay/);
  });
});
