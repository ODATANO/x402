/**
 * `x402Fetch` orchestrates the 402-driven retry loop. We mock the
 * underlying fetch by passing `opts.fetch` (rather than monkey-patching
 * globalThis) so each test has an isolated handler.
 *
 * The pay handler is a stub that returns a known signedTxCborHex +
 * nonceRef; the test asserts the second-attempt request carries a
 * valid PAYMENT-SIGNATURE header that decode() round-trips.
 */

import { x402Fetch } from '../../srv/client/fetch';
import { X402PaymentError } from '../../srv/client/errors';
import { decode } from '../../srv/core/decode';
import { buildBody, signTx } from '../fixtures/build-tx';
import {
  BUYER_PRIV, SELLER_ADDR, NONCE_TX_HASH, NONCE_REF, NETWORK_PREPROD,
} from '../fixtures/constants';
import type {
  PaymentRequirementsBody,
  PaymentRequirementEntry,
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

function res402(): Response {
  return new Response(JSON.stringify(REQS), {
    status: 402,
    headers: { 'Content-Type': 'application/json' },
  });
}
function res200(body = '{"ok":true}'): Response {
  return new Response(body, { status: 200 });
}

describe('x402Fetch', () => {
  it('passes through non-402 responses unchanged', async () => {
    const inner = jest.fn(async () => res200());
    const pay = jest.fn();
    const paid = x402Fetch({ fetch: inner, pay });

    const res = await paid('https://api.example/foo');
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(pay).not.toHaveBeenCalled();
  });

  it('on 402: calls pay, retries with PAYMENT-SIGNATURE, returns the second response', async () => {
    const inner = jest.fn()
      .mockResolvedValueOnce(res402())
      .mockResolvedValueOnce(res200());
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex,
      nonceRef:        NONCE_REF,
    }));
    const paid = x402Fetch({ fetch: inner, pay });

    const res = await paid('https://api.example/foo');
    expect(res.status).toBe(200);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(2);

    // Second call must carry a valid PAYMENT-SIGNATURE.
    const secondInit = inner.mock.calls[1][1] as RequestInit;
    const headers = new Headers(secondInit.headers);
    const headerVal = headers.get('PAYMENT-SIGNATURE');
    expect(headerVal).toBeTruthy();

    // And that header must round-trip through decode().
    const decoded = decode(headerVal!);
    expect(decoded.envelope.network).toBe(NETWORK_PREPROD);
    expect(decoded.envelope.payload.nonce).toBe(NONCE_REF);
    expect(decoded.txHash).toBe(signed.txHash);
  });

  it('stops after maxRetries and returns the last 402', async () => {
    const inner = jest.fn()
      .mockResolvedValueOnce(res402())
      .mockResolvedValueOnce(res402());
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex,
      nonceRef:        NONCE_REF,
    }));
    const paid = x402Fetch({ fetch: inner, pay, maxRetries: 1 });

    const res = await paid('https://api.example/foo');
    expect(res.status).toBe(402);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('does not call pay when 402 body is not a v2 PaymentRequirementsBody', async () => {
    const inner = jest.fn(async () => new Response('plain text 402', { status: 402 }));
    const pay = jest.fn();
    const paid = x402Fetch({ fetch: inner, pay });

    const res = await paid('https://api.example/foo');
    expect(res.status).toBe(402);
    expect(pay).not.toHaveBeenCalled();
  });

  it('applies selectAccepts to choose among multiple accepts entries', async () => {
    const adaEntry = REQS.accepts[0]!;
    const tokenEntry: PaymentRequirementEntry = { ...adaEntry, asset: 'aa'.repeat(28) + '.beef', amount: '5' };
    const body: PaymentRequirementsBody = {
      x402Version: 2,
      accepts: [adaEntry, tokenEntry],
    };

    const inner = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 402 }))
      .mockResolvedValueOnce(res200());

    const seen: PaymentRequirementEntry[] = [];
    const pay = jest.fn(async (req: PaymentRequirementEntry) => {
      seen.push(req);
      return { signedTxCborHex: signed.cborHex, nonceRef: NONCE_REF };
    });

    const paid = x402Fetch({
      fetch: inner,
      pay,
      selectAccepts: (a) => a.find(x => x.asset.includes('.beef')),
    });

    const res = await paid('https://api.example/foo');
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.asset).toContain('.beef');
  });

  it('preserves caller-supplied headers when adding PAYMENT-SIGNATURE', async () => {
    const inner = jest.fn()
      .mockResolvedValueOnce(res402())
      .mockResolvedValueOnce(res200());
    const pay = jest.fn(async () => ({
      signedTxCborHex: signed.cborHex,
      nonceRef:        NONCE_REF,
    }));
    const paid = x402Fetch({ fetch: inner, pay });

    await paid('https://api.example/foo', { headers: { 'X-Trace': 'abc' } });
    const second = new Headers((inner.mock.calls[1][1] as RequestInit).headers);
    expect(second.get('X-Trace')).toBe('abc');
    expect(second.get('PAYMENT-SIGNATURE')).toBeTruthy();
  });

  it('wraps pay-handler errors in X402PaymentError(pay_handler_failed) with original on .cause', async () => {
    const inner = jest.fn().mockResolvedValueOnce(res402());
    const walletError = new Error('wallet refused');
    const pay  = jest.fn(async () => { throw walletError; });
    const paid = x402Fetch({ fetch: inner, pay });

    let caught: unknown;
    try { await paid('https://api.example/foo'); }
    catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(X402PaymentError);
    const e = caught as X402PaymentError;
    expect(e.kind).toBe('pay_handler_failed');
    expect(e.cause).toBe(walletError);
    expect(e.accepts).toBeDefined();
    expect(e.message).toMatch(/wallet refused/);
  });

  it('errorOnFailure: throws X402PaymentError(retries_exhausted) after retries hit cap', async () => {
    const errorBody = { ...REQS, error: 'payment required (wrong_recipient): nope' };
    const inner = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(errorBody), { status: 402 }));
    const pay = jest.fn(async () => ({ signedTxCborHex: signed.cborHex, nonceRef: NONCE_REF }));

    const paid = x402Fetch({ fetch: inner, pay, maxRetries: 1, errorOnFailure: true });
    let caught: unknown;
    try { await paid('https://api.example/foo'); }
    catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(X402PaymentError);
    const e = caught as X402PaymentError;
    expect(e.kind).toBe('retries_exhausted');
    expect(e.code).toBe('wrong_recipient');
    expect(e.serverError).toMatch(/wrong_recipient/);
    expect(e.httpStatus).toBe(402);
    expect(e.accepts).toHaveLength(1);
  });

  it('errorOnFailure: throws X402PaymentError(invalid_402_body) when body is not JSON', async () => {
    const inner = jest.fn(async () => new Response('plain text', { status: 402 }));
    const pay = jest.fn();
    const paid = x402Fetch({ fetch: inner, pay, errorOnFailure: true });
    await expect(paid('https://api.example/foo')).rejects.toMatchObject({
      kind: 'invalid_402_body',
    });
    expect(pay).not.toHaveBeenCalled();
  });

  it('throws if opts.pay is missing', () => {
    expect(() => x402Fetch({ pay: undefined as never })).toThrow(/pay must be a function/);
  });

  it('throws when no fetch implementation is available', () => {
    const originalFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = undefined;
    try {
      expect(() => x402Fetch({ pay: jest.fn() })).toThrow(/no fetch implementation available/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('errorOnFailure + maxRetries=0: re-parses the 402 body on the no-attempts branch', async () => {
    const errorBody = { ...REQS, error: 'payment required (replay): nonce already spent' };
    const inner = jest.fn(async () => new Response(JSON.stringify(errorBody), { status: 402 }));
    const paid = x402Fetch({ fetch: inner, pay: jest.fn(), maxRetries: 0, errorOnFailure: true });
    await expect(paid('https://api.example/foo')).rejects.toMatchObject({
      kind: 'retries_exhausted',
      code: 'replay',
    });
  });

  it('errorOnFailure + maxRetries=0 + unparseable body: throws retries_exhausted with no body', async () => {
    const inner = jest.fn(async () => new Response('not-json', { status: 402 }));
    const paid = x402Fetch({ fetch: inner, pay: jest.fn(), maxRetries: 0, errorOnFailure: true });
    await expect(paid('https://api.example/foo')).rejects.toMatchObject({
      kind: 'retries_exhausted',
      message: expect.stringMatching(/no parsable 402 body/),
    });
  });

  it('errorOnFailure: throws invalid_402_body when JSON parses but is not v2', async () => {
    const inner = jest.fn(async () => new Response(JSON.stringify({ x402Version: 1 }), { status: 402 }));
    const paid = x402Fetch({ fetch: inner, pay: jest.fn(), errorOnFailure: true });
    await expect(paid('https://api.example/foo')).rejects.toMatchObject({
      kind: 'invalid_402_body',
    });
  });

  it('errorOnFailure: throws server_rejected when selectAccepts returns undefined', async () => {
    const inner = jest.fn(async () => new Response(JSON.stringify(REQS), { status: 402 }));
    const paid = x402Fetch({
      fetch: inner,
      pay: jest.fn(),
      errorOnFailure: true,
      selectAccepts: () => undefined,
    });
    await expect(paid('https://api.example/foo')).rejects.toMatchObject({
      kind: 'server_rejected',
    });
  });

  it('without errorOnFailure: select-returns-undefined falls through to the 402 response', async () => {
    const inner = jest.fn(async () => new Response(JSON.stringify(REQS), { status: 402 }));
    const paid = x402Fetch({
      fetch: inner,
      pay: jest.fn(),
      selectAccepts: () => undefined,
    });
    const res = await paid('https://api.example/foo');
    expect(res.status).toBe(402);
  });
});
