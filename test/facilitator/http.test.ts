/**
 * `httpFacilitator` is tested with a fully mocked fetch — we never
 * actually open a socket. The shape contract is what matters:
 *
 *   - POST /verify-settle with the args (minus onAccepted) as JSON body
 *   - Authorization: Bearer <apiKey> when apiKey is set
 *   - Custom `headers()` builder merged on top
 *   - onAccepted invoked locally after the remote returns 'accepted'
 *   - Non-2xx → thrown Error
 *   - GET /supported parses response JSON
 */

import { httpFacilitator } from '../../srv/facilitator/http';
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
  resourceUrl: '/foo',
  nonceRef:    'd'.repeat(64) + '#0',
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status:  init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('httpFacilitator', () => {
  it('POSTs to /verify-settle, strips onAccepted from the wire, invokes it locally on accepted', async () => {
    const remote = {
      kind: 'accepted' as const,
      txHash: ACCEPTED_CLAIM.txHash,
      payment: ACCEPTED_CLAIM,
      paymentResponseB64: 'eyJvayI6dHJ1ZX0=',
    };
    const fetchMock = jest.fn(async () => jsonResponse(remote));
    const onAccepted = jest.fn();

    const fac = httpFacilitator({
      url:    'https://fac.example/v1/',
      apiKey: 'secret',
      fetch:  fetchMock,
    });

    const r = await fac.verifyAndSettle({
      paymentHeader:   'AAA',
      requirementsBody: REQS,
      onAccepted,
    });

    expect(r.kind).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://fac.example/v1/verify-settle'); // trailing slash trimmed
    expect((init as RequestInit).method).toBe('POST');

    const sentHeaders = (init as RequestInit).headers as Record<string, string>;
    expect(sentHeaders['content-type']).toBe('application/json');
    expect(sentHeaders.authorization).toBe('Bearer secret');

    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody).toEqual({
      paymentHeader:    'AAA',
      requirementsBody: REQS,
    });
    expect(sentBody.onAccepted).toBeUndefined(); // never sent over HTTP

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith(ACCEPTED_CLAIM);
  });

  it('does NOT invoke onAccepted on rejected', async () => {
    const remote = {
      kind: 'rejected' as const,
      code: 'wrong_recipient',
      reason: 'nope',
      requirementsBody: REQS,
    };
    const fetchMock = jest.fn(async () => jsonResponse(remote));
    const onAccepted = jest.fn();

    const fac = httpFacilitator({ url: 'https://fac.example', fetch: fetchMock });
    const r = await fac.verifyAndSettle({
      paymentHeader:   'AAA', requirementsBody: REQS, onAccepted,
    });

    expect(r.kind).toBe('rejected');
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('swallows onAccepted callback errors (best-effort, same as local)', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({
      kind: 'accepted',
      txHash: ACCEPTED_CLAIM.txHash,
      payment: ACCEPTED_CLAIM,
      paymentResponseB64: 'xx',
    }));
    const fac = httpFacilitator({ url: 'https://fac.example', fetch: fetchMock });

    const r = await fac.verifyAndSettle({
      paymentHeader:   'AAA', requirementsBody: REQS,
      onAccepted: async () => { throw new Error('audit DB down'); },
    });
    expect(r.kind).toBe('accepted'); // never propagates
  });

  it('throws on non-2xx response', async () => {
    const fetchMock = jest.fn(async () => new Response('boom', { status: 503 }));
    const fac = httpFacilitator({ url: 'https://fac.example', fetch: fetchMock });

    await expect(
      fac.verifyAndSettle({ paymentHeader: 'A', requirementsBody: REQS }),
    ).rejects.toThrow(/503/);
  });

  it('merges custom headers() on top of defaults', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({
      kind: 'rejected', code: 'x', reason: 'y', requirementsBody: REQS,
    }));

    const fac = httpFacilitator({
      url:     'https://fac.example',
      apiKey:  'should-be-overridden',
      headers: async () => ({ authorization: 'Bearer custom', 'x-trace': 'abc' }),
      fetch:   fetchMock,
    });
    await fac.verifyAndSettle({ paymentHeader: 'A', requirementsBody: REQS });

    const sentHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe('Bearer custom');
    expect(sentHeaders['x-trace']).toBe('abc');
  });

  it('supported() fetches GET /supported and parses the response', async () => {
    const fetchMock = jest.fn(async () => jsonResponse({
      networks: ['cardano:preprod'],
      assetTransferMethods: ['default', 'masumi'],
    }));
    const fac = httpFacilitator({ url: 'https://fac.example', fetch: fetchMock });

    const s = await fac.supported!();
    expect(s.networks).toEqual(['cardano:preprod']);
    expect(s.assetTransferMethods).toContain('masumi');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://fac.example/supported');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('throws on missing url', () => {
    expect(() => httpFacilitator({ url: '' })).toThrow(/url is required/);
  });
});
