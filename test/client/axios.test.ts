/**
 * `x402Axios` is tested against a hand-rolled minimal axios shim — we
 * don't pull in real axios as a dev dependency just for one test file.
 * The shim faithfully reproduces the interceptor + request contract,
 * which is all `x402Axios` touches.
 */

import { x402Axios } from '../../srv/client/axios';
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
 * `request()` consumes one entry — if it has `error`, the
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

  it('throws if opts.pay is missing', () => {
    const { instance } = makeShim([]);
    expect(() => x402Axios(instance, { pay: undefined as never })).toThrow(/pay must be a function/);
  });
});
