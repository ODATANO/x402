/**
 * Resource-server flow shared by the Express and CAP integrations:
 * `startPayment` (402, 400, accepted matching, verify, verifyTransfer)
 * and `finishPayment` (settle, `PAYMENT-RESPONSE`). The facilitator is a
 * fake; payment headers carry real signed transactions.
 */

// decodePayment runs through srv/bridge → @odatano/core; stub the barrel to its pure parser.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

import {
  startPayment,
  finishPayment,
  paymentRequiredFor,
  requiredAnswer,
  type PaymentGateOptions,
  type PaymentSession,
} from '../../srv/middleware/flow';
import { Codes } from '../../srv/core/errors';
import { memoryIssuedRequirementsStore } from '../../srv/middleware/issued';
import {
  BUYER_ADDR, BUYER_PRIV, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  NETWORK_PREPROD, TTL_SLOT,
} from '../fixtures/constants';
import { buildBody, signTx, type TestOutput } from '../fixtures/build-tx';
import { buildPaymentSignature, decodeHeader, encodeRawPayload } from '../fixtures/envelope';
import type { Facilitator } from '../../srv/facilitator/adapter';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  RouteOption,
  SettlementResponse,
  VerifyResponse,
} from '../../srv/core/types';

const URL = '/odata/v4/prices/Quotes';
const opts: PaymentGateOptions = {
  payTo: SELLER_ADDR, network: NETWORK_PREPROD, asset: 'lovelace', description: 'Quotes',
};
const options: RouteOption[] = [{ amount: '1000000' }];

function offered(): PaymentRequirements {
  return paymentRequiredFor(opts, options, URL).accepts[0]!;
}

function signedHeader(
  accepted: PaymentRequirements = offered(),
  outputs: TestOutput[] = [{ address: SELLER_ADDR, lovelace: '1000000' }],
): { header: string; txHash: string } {
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs,
    ttlSlot: TTL_SLOT,
  });
  const signed = signTx(body, [BUYER_PRIV]);
  return { header: buildPaymentSignature({ accepted, txCborHex: signed.cborHex, nonceRef: NONCE_REF }), txHash: signed.txHash };
}

const SETTLED: SettlementResponse = {
  success: true, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD, payer: BUYER_ADDR, amount: '1000000',
  extra: { status: 'confirmed', confirmations: 1 },
};

function fakeFacilitator(
  verify: VerifyResponse = { isValid: true, payer: BUYER_ADDR },
  settle: SettlementResponse = SETTLED,
) {
  return {
    verify: jest.fn<Promise<VerifyResponse>, [PaymentPayload, PaymentRequirements]>().mockResolvedValue(verify),
    settle: jest.fn<Promise<SettlementResponse>, [PaymentPayload, PaymentRequirements]>().mockResolvedValue(settle),
  } satisfies Facilitator;
}

function requiredOf(headers: Record<string, string>): PaymentRequired {
  return decodeHeader<PaymentRequired>(headers['PAYMENT-REQUIRED']);
}

async function proceed(f: Facilitator = fakeFacilitator()): Promise<PaymentSession> {
  const r = await startPayment(opts, f, options, URL, signedHeader().header);
  if (r.kind !== 'proceed') throw new Error(`expected proceed, got ${JSON.stringify(r.answer.body)}`);
  return r.session;
}

describe('paymentRequiredFor', () => {
  it('describes the resource once and marks fees as not sponsored', () => {
    const pr = paymentRequiredFor(
      { ...opts, serviceName: 'Prices', tags: ['finance'], confirmationPolicy: { l1Confirmations: 2 }, extensions: { x: 1 } },
      options, URL,
    );
    expect(pr.resource).toEqual({
      url: URL, description: 'Quotes', mimeType: 'application/json', serviceName: 'Prices', tags: ['finance'],
    });
    expect(pr.accepts[0]).not.toHaveProperty('resource');
    expect(pr.accepts[0]!.extra).toEqual({ areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 2 } });
    expect(pr.extensions).toEqual({ x: 1 });
  });
});

describe('requiredAnswer', () => {
  it('puts the PaymentRequired with the error into the header and the body', () => {
    const pr = paymentRequiredFor(opts, options, URL);
    const a = requiredAnswer(pr, 'nope', 400, { 'X-Extra': '1' });
    expect(a.status).toBe(400);
    expect(a.headers['X-Extra']).toBe('1');
    expect(requiredOf(a.headers)).toEqual({ ...pr, error: 'nope' });
    expect(a.body).toEqual({ ...pr, error: 'nope' });
  });
});

describe('startPayment', () => {
  it('answers 402 with PAYMENT-REQUIRED when no payment is attached', async () => {
    const f = fakeFacilitator();
    const r = await startPayment(opts, f, options, URL, undefined);
    expect(r.kind).toBe('answer');
    if (r.kind !== 'answer') return;
    expect(r.answer.status).toBe(402);
    const pr = requiredOf(r.answer.headers);
    expect(pr.x402Version).toBe(2);
    expect(pr.error).toBe('PAYMENT-SIGNATURE header is required');
    expect(pr.resource.url).toBe(URL);
    expect(pr.accepts).toEqual([offered()]);
    expect(pr.accepts[0]!.extra?.areFeesSponsored).toBe(false);
    expect(r.answer.body).toEqual(pr);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('answers 400 for a header that is not base64 JSON', async () => {
    const f = fakeFacilitator();
    const r = await startPayment(opts, f, options, URL, 'not base64!!');
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(400);
    expect(requiredOf(r.answer.headers).error).toContain(`(${Codes.INVALID_PAYLOAD})`);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('answers 400 for an unsupported x402Version', async () => {
    const r = await startPayment(opts, fakeFacilitator(), options, URL, encodeRawPayload({ x402Version: 1 }));
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(400);
    expect(requiredOf(r.answer.headers).error).toContain(`(${Codes.UNSUPPORTED_VERSION})`);
  });

  it('answers 402 when accepted is not one of the offered entries', async () => {
    const f = fakeFacilitator();
    const r = await startPayment(opts, f, options, URL, signedHeader({ ...offered(), amount: '5' }).header);
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(402);
    expect(requiredOf(r.answer.headers).error).toContain(`(${Codes.ACCEPTED_MISMATCH})`);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('matches a CIP-34 network alias in accepted', async () => {
    const r = await startPayment(opts, fakeFacilitator(), options, URL, signedHeader({ ...offered(), network: 'cip34:0-1' as never }).header);
    expect(r.kind).toBe('proceed');
  });

  it('answers 402 with the facilitator code when verify fails', async () => {
    const f = fakeFacilitator({ isValid: false, invalidReason: Codes.REPLAY, extra: { reason: 'nonce spent' } });
    const r = await startPayment(opts, f, options, URL, signedHeader().header);
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(402);
    expect(requiredOf(r.answer.headers).error).toBe(`payment rejected (${Codes.REPLAY}): nonce spent`);
  });

  it('answers 400 when verify reports a malformed payload', async () => {
    const f = fakeFacilitator({ isValid: false, invalidReason: Codes.INVALID_CBOR });
    const r = await startPayment(opts, f, options, URL, signedHeader().header);
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(400);
  });

  it('rejects a payment whose payTo output does not pay the entry, even if the facilitator passed it', async () => {
    const r = await startPayment(
      opts, fakeFacilitator(), options, URL,
      signedHeader(offered(), [{ address: BUYER_ADDR, lovelace: '1000000' }]).header,
    );
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(requiredOf(r.answer.headers).error).toContain(`(${Codes.WRONG_RECIPIENT})`);
  });

  it('answers 402 transfer_rejected when verifyTransfer says no', async () => {
    const verifyTransfer = jest.fn().mockResolvedValue({ ok: false, reason: 'wrong order' });
    const { header, txHash } = signedHeader();
    const r = await startPayment({ ...opts, verifyTransfer }, fakeFacilitator(), options, URL, header);
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(402);
    expect(requiredOf(r.answer.headers).error).toBe(`payment rejected (${Codes.TRANSFER_REJECTED}): wrong order`);
    expect(verifyTransfer.mock.calls[0]![0].decoded.txHash).toBe(txHash);
    expect(verifyTransfer.mock.calls[0]![0].requirement).toEqual(offered());
  });

  it('proceeds with a verified claim', async () => {
    const f = fakeFacilitator();
    const { header, txHash } = signedHeader();
    const r = await startPayment(opts, f, options, URL, header);
    if (r.kind !== 'proceed') throw new Error('expected proceed');
    expect(f.verify).toHaveBeenCalledWith(r.session.payload, offered());
    expect(r.session.requirements).toEqual(offered());
    expect(r.session.claim).toEqual({
      txHash,
      amountUnits: '1000000',
      network:     NETWORK_PREPROD,
      unit:        '',
      asset:       'lovelace',
      payTo:       SELLER_ADDR,
      resourceUrl: URL,
      nonceRef:    NONCE_REF,
      payerAddr:   BUYER_ADDR,
    });
  });
});

describe('finishPayment', () => {
  it('returns the settled claim and PAYMENT-RESPONSE', async () => {
    const f = fakeFacilitator();
    const session = await proceed(f);
    const r = await finishPayment(f, session);
    expect(f.settle).toHaveBeenCalledWith(session.payload, session.requirements);
    if (r.kind !== 'settled') throw new Error('expected settled');
    expect(decodeHeader(r.headers['PAYMENT-RESPONSE'])).toEqual(SETTLED);
    expect(r.claim).toEqual(session.claim);
  });

  it('takes the payer from settle when verify did not name one', async () => {
    const f = fakeFacilitator({ isValid: true });
    const session = await proceed(f);
    const r = await finishPayment(f, session);
    if (r.kind !== 'settled') throw new Error('expected settled');
    expect(r.claim.payerAddr).toBe(BUYER_ADDR);
  });

  it.each([
    ['a failed settlement', Codes.SUBMIT_FAILED],
    ['a pending settlement', Codes.PENDING],
  ])('answers 402 with PAYMENT-RESPONSE and PAYMENT-REQUIRED for %s', async (_label, errorReason) => {
    const failed: SettlementResponse = { success: false, errorReason, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD };
    const f = fakeFacilitator(undefined, failed);
    const r = await finishPayment(f, await proceed(f));
    if (r.kind !== 'answer') throw new Error('expected answer');
    expect(r.answer.status).toBe(402);
    expect(decodeHeader(r.answer.headers['PAYMENT-RESPONSE'])).toEqual(failed);
    expect(requiredOf(r.answer.headers).error).toBe(`payment rejected (${errorReason})`);
    expect(f.settle).toHaveBeenCalledTimes(errorReason === Codes.PENDING ? 2 : 1);
  });

  it('settles once more after a pending answer and delivers when that confirms', async () => {
    const pending: SettlementResponse = { success: false, errorReason: Codes.PENDING, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD };
    const f = fakeFacilitator();
    f.settle.mockResolvedValueOnce(pending);
    const r = await finishPayment(f, await proceed(f));
    expect(r.kind).toBe('settled');
    expect(f.settle).toHaveBeenCalledTimes(2);
  });
});

describe('startPayment, issued requirements', () => {
  // A route that prices each request differently: the datum names the order.
  const perOrder = (order: string): RouteOption[] => [{ amount: '1000000', extra: { order } }];

  it('matches the paid retry against what the 402 offered, not against a fresh price', async () => {
    const issuedRequirements = memoryIssuedRequirementsStore();
    const gate = { ...opts, issuedRequirements };
    const first = await startPayment(gate, fakeFacilitator(), perOrder('A'), URL, undefined);
    if (first.kind !== 'answer') throw new Error('expected 402');
    const offeredA = requiredOf(first.answer.headers).accepts[0]!;

    const r = await startPayment(gate, fakeFacilitator(), perOrder('B'), URL, signedHeader(offeredA).header);
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') expect(r.session.requirements.extra).toMatchObject({ order: 'A' });
  });

  it('does not accept an entry offered for another route', async () => {
    const issuedRequirements = memoryIssuedRequirementsStore();
    const gate = { ...opts, issuedRequirements };
    const first = await startPayment(gate, fakeFacilitator(), perOrder('A'), '/other', undefined);
    if (first.kind !== 'answer') throw new Error('expected 402');
    const offeredA = requiredOf(first.answer.headers).accepts[0]!;

    const r = await startPayment(gate, fakeFacilitator(), perOrder('B'), URL, signedHeader(offeredA).header);
    expect(r.kind).toBe('answer');
    if (r.kind === 'answer') expect(String((r.answer.body as PaymentRequired).error)).toContain(Codes.ACCEPTED_MISMATCH);
  });

  it('without a store, a changed price rejects the retry', async () => {
    const offeredA = paymentRequiredFor(opts, perOrder('A'), URL).accepts[0]!;
    const r = await startPayment(opts, fakeFacilitator(), perOrder('B'), URL, signedHeader(offeredA).header);
    expect(r.kind).toBe('answer');
  });
});
