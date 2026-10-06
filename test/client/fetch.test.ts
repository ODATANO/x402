/**
 * `x402Fetch` drives the 402 → pay → retry loop. The underlying fetch is
 * passed as `opts.fetch`, so each test has an isolated handler.
 */

import { x402Fetch } from '../../srv/client/fetch';
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
  extra: { areFeesSponsored: false },
};

const REQUIRED: PaymentRequired = {
  x402Version: 2,
  error: 'PAYMENT-SIGNATURE header is required',
  resource: { url: 'https://api.example/foo', mimeType: 'application/json' },
  accepts: [ACCEPTED],
  extensions: { demo: { info: {}, schema: {} } },
};

const TX_HASH = 'ab'.repeat(32);
const PAID = { signedTxCborHex: 'cafe', nonceRef: NONCE_REF };

function res402(opts: { required?: PaymentRequired | null; settlement?: SettlementResponse; body?: unknown } = {}): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const required = opts.required === undefined ? REQUIRED : opts.required;
  if (required) headers['PAYMENT-REQUIRED'] = encodeRawPayload(required);
  if (opts.settlement) headers['PAYMENT-RESPONSE'] = encodeRawPayload(opts.settlement);
  return new Response(JSON.stringify(opts.body ?? required ?? {}), { status: 402, headers });
}
function res200(): Response {
  return new Response('{"ok":true}', { status: 200 });
}
const pending: SettlementResponse = {
  success: false, errorReason: Codes.PENDING, transaction: TX_HASH, network: NETWORK_PREPROD,
};

function sentHeader(inner: jest.Mock, call: number): string | null {
  const init = inner.mock.calls[call]![1] as RequestInit | undefined;
  return new Headers(init?.headers).get('PAYMENT-SIGNATURE');
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

describe('x402Fetch', () => {
  it('passes through non-402 responses unchanged', async () => {
    const inner = jest.fn(async () => res200());
    const pay = jest.fn();
    const res = await x402Fetch({ fetch: inner, pay })('https://api.example/foo');
    expect(res.status).toBe(200);
    expect(pay).not.toHaveBeenCalled();
  });

  it('pays from PAYMENT-REQUIRED and retries with a spec PaymentPayload', async () => {
    const inner = jest.fn().mockResolvedValueOnce(res402()).mockResolvedValueOnce(res200());
    const pay = jest.fn(async () => PAID);
    const res = await x402Fetch({ fetch: inner, pay })('https://api.example/foo');

    expect(res.status).toBe(200);
    expect(pay).toHaveBeenCalledWith(ACCEPTED, REQUIRED);
    const payload = decodeHeader<PaymentPayload>(sentHeader(inner, 1));
    expect(payload.accepted).toEqual(ACCEPTED);
    expect(payload.resource).toEqual(REQUIRED.resource);
    expect(payload.extensions).toEqual(REQUIRED.extensions);
    expect(payload.payload).toEqual({ transaction: Buffer.from('cafe', 'hex').toString('base64'), nonce: NONCE_REF });
  });

  it('does not mutate the caller init', async () => {
    const inner = jest.fn().mockResolvedValueOnce(res402()).mockResolvedValueOnce(res200());
    const init: RequestInit = { method: 'POST', headers: { 'x-custom': '1' } };
    await x402Fetch({ fetch: inner, pay: async () => PAID })('https://api.example/foo', init);
    expect(init.headers).toEqual({ 'x-custom': '1' });
    const sent = new Headers((inner.mock.calls[1]![1] as RequestInit).headers);
    expect(sent.get('x-custom')).toBe('1');
    expect((inner.mock.calls[1]![1] as RequestInit).method).toBe('POST');
  });

  it('treats a body-only 402 as invalid_payment_required', async () => {
    const inner = jest.fn(async () => res402({ required: null, body: REQUIRED }));
    const pay = jest.fn();
    await expect(x402Fetch({ fetch: inner, pay, errorOnFailure: true })('https://api.example/foo'))
      .rejects.toMatchObject({ kind: 'invalid_payment_required' });
    expect(pay).not.toHaveBeenCalled();
  });

  it('returns the 402 for a body-only 402 without errorOnFailure', async () => {
    const inner = jest.fn(async () => res402({ required: null, body: REQUIRED }));
    const res = await x402Fetch({ fetch: inner, pay: jest.fn() })('https://api.example/foo');
    expect(res.status).toBe(402);
  });

  it('re-sends the same header on settlement_pending without paying again', async () => {
    const inner = jest.fn()
      .mockResolvedValueOnce(res402())
      .mockResolvedValueOnce(res402({ settlement: pending }))
      .mockResolvedValueOnce(res402({ settlement: pending }))
      .mockResolvedValueOnce(res200());
    const pay = jest.fn(async () => PAID);
    const res = await x402Fetch({ fetch: inner, pay, pendingRetryDelayMs: 0 })('https://api.example/foo');

    expect(res.status).toBe(200);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(sentHeader(inner, 2)).toBe(sentHeader(inner, 1));
    expect(sentHeader(inner, 3)).toBe(sentHeader(inner, 1));
  });

  it('throws settlement_pending once pendingRetries are used up', async () => {
    const inner = jest.fn()
      .mockResolvedValueOnce(res402())
      .mockResolvedValue(res402({ settlement: pending }));
    const pay = jest.fn(async () => PAID);
    const err = await rejection(x402Fetch({ fetch: inner, pay, pendingRetries: 2, pendingRetryDelayMs: 0, errorOnFailure: true })(
      'https://api.example/foo',
    ));

    expect(err).toBeInstanceOf(X402PaymentError);
    expect(err.kind).toBe('settlement_pending');
    expect(err.settlement).toEqual(pending);
    expect(inner).toHaveBeenCalledTimes(4);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it('returns the pending 402 without errorOnFailure', async () => {
    const inner = jest.fn().mockResolvedValueOnce(res402()).mockResolvedValue(res402({ settlement: pending }));
    const res = await x402Fetch({ fetch: inner, pay: async () => PAID, pendingRetries: 0 })('https://api.example/foo');
    expect(res.status).toBe(402);
  });

  it('throws retries_exhausted with the failed settlement', async () => {
    const failed: SettlementResponse = {
      success: false, errorReason: Codes.SUBMIT_FAILED, transaction: '', network: NETWORK_PREPROD,
    };
    const rejected = { ...REQUIRED, error: `payment rejected (${Codes.SUBMIT_FAILED})` };
    const inner = jest.fn()
      .mockResolvedValueOnce(res402())
      .mockResolvedValueOnce(res402({ required: rejected, settlement: failed }));
    const err = await rejection(x402Fetch({ fetch: inner, pay: async () => PAID, errorOnFailure: true })('https://api.example/foo'));

    expect(err.kind).toBe('retries_exhausted');
    expect(err.code).toBe(Codes.SUBMIT_FAILED);
    expect(err.accepts).toEqual(rejected.accepts);
  });

  it('returns the last 402 when retries are exhausted without errorOnFailure', async () => {
    const inner = jest.fn().mockResolvedValue(res402());
    const res = await x402Fetch({ fetch: inner, pay: async () => PAID })('https://api.example/foo');
    expect(res.status).toBe(402);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('throws server_rejected when no entry is selectable', async () => {
    const masumi = { ...REQUIRED, accepts: [{ ...ACCEPTED, extra: { assetTransferMethod: 'masumi' } }] };
    const inner = jest.fn(async () => res402({ required: masumi as unknown as PaymentRequired }));
    const pay = jest.fn();
    await expect(x402Fetch({ fetch: inner, pay, errorOnFailure: true })('https://api.example/foo'))
      .rejects.toMatchObject({ kind: 'server_rejected' });
    expect(pay).not.toHaveBeenCalled();
  });

  it('honours selectAccepts', async () => {
    const second = { ...ACCEPTED, amount: '2000000' };
    const inner = jest.fn()
      .mockResolvedValueOnce(res402({ required: { ...REQUIRED, accepts: [ACCEPTED, second] } }))
      .mockResolvedValueOnce(res200());
    const pay = jest.fn<Promise<typeof PAID>, [PaymentRequirements, PaymentRequired]>(async () => PAID);
    await x402Fetch({ fetch: inner, pay, selectAccepts: a => a[1] })('https://api.example/foo');
    expect(pay.mock.calls[0]![0]).toEqual(second);
  });

  it('wraps pay handler errors regardless of errorOnFailure', async () => {
    const inner = jest.fn(async () => res402());
    const boom = new Error('wallet refused');
    const err = await rejection(x402Fetch({ fetch: inner, pay: async () => { throw boom; } })('https://api.example/foo'));
    expect(err.kind).toBe('pay_handler_failed');
    expect(err.cause).toBe(boom);
    expect(err.accepts).toEqual(REQUIRED.accepts);
  });

  it('rejects construction without a pay handler', () => {
    expect(() => x402Fetch({} as never)).toThrow(/opts.pay/);
  });
});
