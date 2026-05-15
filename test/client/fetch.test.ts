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

  it('throws when pay rejects', async () => {
    const inner = jest.fn().mockResolvedValueOnce(res402());
    const pay  = jest.fn(async () => { throw new Error('wallet refused'); });
    const paid = x402Fetch({ fetch: inner, pay });

    await expect(paid('https://api.example/foo')).rejects.toThrow('wallet refused');
  });

  it('throws if opts.pay is missing', () => {
    expect(() => x402Fetch({ pay: undefined as never })).toThrow(/pay must be a function/);
  });
});
