/**
 * `x402Axios` is tested against a hand-rolled minimal axios shim, we
 * don't pull in real axios as a dev dependency just for one test file.
 * The shim faithfully reproduces the interceptor + request contract,
 * which is all `x402Axios` touches.
 */

import { x402Axios } from '../../srv/client/axios';
import { X402PaymentError } from '../../srv/client/errors';
import { decode } from '../../srv/core/decode';
import { buildBody, signTx } from '../fixtures/build-tx';
import {
  BUYER_PRIV, SELLER_ADDR, NONCE_TX_HASH, NONCE_REF, NETWORK_PREPROD,
} from '../fixtures/constants';
import type {
  PaymentRequirementsBody,
} from '../../srv/core/types';

const signed = (() => {
  const body = buildBody({
    inputs:  [{ txHash: NONCE_TX_HASH, outputIndex: 0 }],
    outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    ttlSlot: 80_000_500,
  });
  return signTx(body, [BUYER_PRIV]);
})();

const REQS: PaymentRequirementsBody = {
  x402Version: 2,
  accepts: [{
    scheme:              'exact',
    network:             NETWORK_PREPROD,
    asset:               'lovelace',
    amount:              '1000000',
    payTo:               SELLER_ADDR,
    resource:            { url: 'https://api.example/foo', description: 'X', mimeType: 'application/json' },
    assetTransferMethod: 'default',
    maxTimeoutSeconds:   600,
  }],
};

/**
 * Minimal axios-shaped client. `responses` is a FIFO queue: each
 * `request()` consumes one entry, if it has `error`, the
 * onRejected interceptor fires; otherwise onFulfilled.
 */
function makeShim(responses: Array<{ status: number; data?: unknown }>) {
  type Handler = (x: unknown) => unknown;
  let onFulfilled: Handler = (r) => r;
  let onRejected:  Handler = (e) => { throw e; };

  const calls: Array<Record<string, unknown>> = [];

  const instance = {
    interceptors: {
      response: {
        use(f: Handler, r: Handler) {
          onFulfilled = f;
          onRejected  = r;
          return 0;
        },
      },
    },
    async request(cfg: Record<string, unknown>) {
      calls.push(cfg);
      const next = responses.shift();
      if (!next) throw new Error('shim: ran out of queued responses');
      if (next.status >= 400) {
        const err = Object.assign(new Error(`HTTP ${next.status}`), {
          response: { status: next.status, data: next.data },
          config:   cfg,
        });
        return onRejected(err);
      }
      return onFulfilled({ status: next.status, data: next.data, config: cfg });
    },
  };

  return { instance, calls };
}

describe('x402Axios', () => {
  it('passes non-402 responses through unchanged', async () => {
    const { instance, calls } = makeShim([{ status: 200, data: 'ok' }]);
    const client = x402Axios(instance, { pay: jest.fn() });
    const res = await client.request({ url: '/foo' }) as { status: number };
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('on 402: pays, retries with PAYMENT-SIGNATURE, returns the second response', async () => {
    const { instance, calls } = makeShim([
      { status: 402, data: REQS },
      { status: 200, data: 'paid' },
    ]);
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex,
      nonceRef:        NONCE_REF,
    }));
    const client = x402Axios(instance, { pay });

    const res = await client.request({ url: '/foo', headers: { 'X-Trace': 't1' } }) as { status: number; data: string };
    expect(res.status).toBe(200);
    expect(res.data).toBe('paid');
    expect(pay).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);

    // Second call merged headers: PAYMENT-SIGNATURE added, X-Trace preserved.
    const secondHeaders = (calls[1]!.headers ?? {}) as Record<string, string>;
    expect(secondHeaders['X-Trace']).toBe('t1');
    const header = secondHeaders['PAYMENT-SIGNATURE'];
    expect(header).toBeTruthy();

    // And the header round-trips through decode().
    const decoded = decode(header);
    expect(decoded.txHash).toBe(signed.txHash);
    expect(decoded.envelope.payload.nonce).toBe(NONCE_REF);
  });

  it('rejects (propagates the 402 error) when no v2 accepts present', async () => {
    const { instance } = makeShim([{ status: 402, data: { x402Version: 1 } }]);
    const pay = jest.fn();
    const client = x402Axios(instance, { pay });
    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({ response: { status: 402 } });
    expect(pay).not.toHaveBeenCalled();
  });

  it('does not loop past maxRetries (second 402 propagates)', async () => {
    const { instance, calls } = makeShim([
      { status: 402, data: REQS },
      { status: 402, data: REQS },
    ]);
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex,
      nonceRef:        NONCE_REF,
    }));
    const client = x402Axios(instance, { pay, maxRetries: 1 });

    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({ response: { status: 402 } });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('wraps pay-handler errors in X402PaymentError(pay_handler_failed)', async () => {
    const { instance } = makeShim([{ status: 402, data: REQS }]);
    const walletError = new Error('wallet cancelled');
    const pay = jest.fn(async () => { throw walletError; });
    const client = x402Axios(instance, { pay });

    try {
      await client.request({ url: '/foo' });
      throw new Error('should not reach here');
    } catch (err) {
      expect(err).toBeInstanceOf(X402PaymentError);
      const e = err as X402PaymentError;
      expect(e.kind).toBe('pay_handler_failed');
      expect(e.cause).toBe(walletError);
    }
  });

  it('errorOnFailure: wraps retries-exhausted in X402PaymentError', async () => {
    const errorBody = { ...REQS, error: 'payment required (insufficient_amount): paid 1 < required 1000' };
    const { instance } = makeShim([
      { status: 402, data: errorBody },
      { status: 402, data: errorBody },
    ]);
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex, nonceRef: NONCE_REF,
    }));
    const client = x402Axios(instance, { pay, maxRetries: 1, errorOnFailure: true });

    try {
      await client.request({ url: '/foo' });
      throw new Error('should not reach here');
    } catch (err) {
      expect(err).toBeInstanceOf(X402PaymentError);
      const e = err as X402PaymentError;
      expect(e.kind).toBe('retries_exhausted');
      expect(e.code).toBe('insufficient_amount');
      expect(e.httpStatus).toBe(402);
    }
  });

  it('default behaviour without errorOnFailure: still re-throws the original AxiosError', async () => {
    const { instance } = makeShim([
      { status: 402, data: REQS },
      { status: 402, data: REQS },
    ]);
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex, nonceRef: NONCE_REF,
    }));
    const client = x402Axios(instance, { pay, maxRetries: 1 });
    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({ response: { status: 402 } });
  });

  it('throws if opts.pay is missing', () => {
    const { instance } = makeShim([]);
    expect(() => x402Axios(instance, { pay: undefined as never })).toThrow(/pay must be a function/);
  });

  it('rethrows non-402 errors untouched', async () => {
    const { instance } = makeShim([{ status: 500, data: { msg: 'oops' } }]);
    const client = x402Axios(instance, { pay: jest.fn() });
    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({ response: { status: 500 } });
  });

  it('errorOnFailure: wraps invalid_402_body when JSON parses but is not v2', async () => {
    const { instance } = makeShim([{ status: 402, data: { x402Version: 1 } }]);
    const client = x402Axios(instance, { pay: jest.fn(), errorOnFailure: true });
    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({
      kind: 'invalid_402_body',
    });
  });

  it('errorOnFailure: wraps server_rejected when selectAccepts returns undefined', async () => {
    const { instance } = makeShim([{ status: 402, data: REQS }]);
    const client = x402Axios(instance, {
      pay: jest.fn(),
      errorOnFailure: true,
      selectAccepts: () => undefined,
    });
    await expect(client.request({ url: '/foo' })).rejects.toBeInstanceOf(X402PaymentError);
  });

  it('without errorOnFailure: select-returns-undefined rethrows the original 402', async () => {
    const { instance } = makeShim([{ status: 402, data: REQS }]);
    const client = x402Axios(instance, {
      pay: jest.fn(),
      selectAccepts: () => undefined,
    });
    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({ response: { status: 402 } });
  });

  it('errorOnFailure: retries_exhausted falls back to invalid_402_body when last body is not v2', async () => {
    // Both responses lack a v2 shape, the very first attempt is rejected
    // via "invalid_402_body" instead of looping. This exercises maybeWrap's
    // fallback constructor (line 79).
    const { instance } = makeShim([{ status: 402, data: 'plain string' }]);
    const client = x402Axios(instance, { pay: jest.fn(), errorOnFailure: true });
    await expect(client.request({ url: '/foo' })).rejects.toMatchObject({
      kind: 'invalid_402_body',
    });
  });
});
