/** httpFacilitator against a mocked fetch: wire shape of /verify, /settle, /supported. */

import { httpFacilitator } from '../../srv/facilitator/http';
import { buildRequirements } from '../../srv/core/requirements';
import { SELLER_ADDR, NETWORK_PREPROD, NONCE_REF } from '../fixtures/constants';
import type { PaymentPayload } from '../../srv/core/types';

const req = buildRequirements({ amount: 2_000_000n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });
const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: 'AAAA', nonce: NONCE_REF } };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

function fetchReturning(body: unknown, status = 200): FetchMock {
  return jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () => jsonResponse(body, status));
}

describe('httpFacilitator', () => {
  it('POSTs /verify with the spec body and returns the VerifyResponse', async () => {
    const fetch = fetchReturning({ isValid: true, payer: 'addr_test1payer' });
    const fac = httpFacilitator({ url: 'https://fac.example/v1/', fetch });
    expect(await fac.verify(payload, req)).toEqual({ isValid: true, payer: 'addr_test1payer' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://fac.example/v1/verify');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
  });

  it('POSTs /settle and returns the SettlementResponse', async () => {
    const settled = { success: true, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD };
    const fetch = fetchReturning(settled);
    const fac = httpFacilitator({ url: 'https://fac.example', fetch });
    expect(await fac.settle(payload, req)).toEqual(settled);
    expect(String(fetch.mock.calls[0]![0])).toBe('https://fac.example/settle');
  });

  it('GETs /supported', async () => {
    const supported = { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK_PREPROD }], extensions: [], signers: {} };
    const fetch = fetchReturning(supported);
    const fac = httpFacilitator({ url: 'https://fac.example', fetch });
    expect(await fac.supported!()).toEqual(supported);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://fac.example/supported');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('sends the API key as bearer and merges custom headers', async () => {
    const fetch = fetchReturning({ isValid: true });
    const fac = httpFacilitator({ url: 'https://fac.example', apiKey: 'secret', headers: async () => ({ 'x-request-id': 'r1' }), fetch });
    await fac.verify(payload, req);
    const headers = fetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({ authorization: 'Bearer secret', 'x-request-id': 'r1', 'content-type': 'application/json' });
  });

  it('throws on a non-2xx answer', async () => {
    const fac = httpFacilitator({ url: 'https://fac.example', fetch: fetchReturning({ error: 'x' }, 503) });
    await expect(fac.settle(payload, req)).rejects.toThrow(/POST \/settle returned 503/);
  });

  it('aborts after timeoutMs', async () => {
    const fetch: FetchMock = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const fac = httpFacilitator({ url: 'https://fac.example', fetch, timeoutMs: 20 });
    await expect(fac.verify(payload, req)).rejects.toThrow('aborted');
  });

  it('requires a url and a fetch implementation', () => {
    expect(() => httpFacilitator({ url: '' })).toThrow(/url is required/);
    const original = globalThis.fetch;
    Object.assign(globalThis, { fetch: undefined });
    try {
      expect(() => httpFacilitator({ url: 'https://fac.example' })).toThrow(/no fetch implementation/);
    } finally {
      Object.assign(globalThis, { fetch: original });
    }
  });
});
