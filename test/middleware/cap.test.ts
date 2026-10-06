/**
 * CAP gate: `before('*')` verifies and registers a `succeeded` listener on
 * the request; that listener settles after the handler's commit. A fake
 * service captures the handler; requests are hand-built `cds.Request`
 * stand-ins whose `commit()` runs the listener. The facilitator is a fake;
 * payment headers carry real signed transactions.
 */

// decodePayment runs through srv/bridge → @odatano/core; stub the barrel to its pure parser.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@odatano/core', () => require('../fixtures/core-parse-mock').coreParseMock());

const mockPersistReceipt = jest.fn();
jest.mock('../../srv/middleware/receipts', () => ({
  ...jest.requireActual('../../srv/middleware/receipts'),
  persistReceipt: (...args: unknown[]) => mockPersistReceipt(...args),
}));

const mockIssueGrant  = jest.fn();
const mockLookupGrant = jest.fn();
jest.mock('../../srv/middleware/grants', () => ({
  ...jest.requireActual('../../srv/middleware/grants'),
  issueGrant:  (...args: unknown[]) => mockIssueGrant(...args),
  lookupGrant: (...args: unknown[]) => mockLookupGrant(...args),
}));

const mockLocalFacilitator = jest.fn();
const mockDefaultFacilitator = jest.fn();
jest.mock('../../srv/facilitator/adapter', () => ({
  localFacilitator: (...args: unknown[]) => mockLocalFacilitator(...args),
  defaultFacilitator: () => mockDefaultFacilitator(),
}));

const mockCdsSettlementStore = jest.fn((entity: string) => ({ store: entity }));
jest.mock('../../srv/facilitator/cds-store', () => ({
  ...jest.requireActual('../../srv/facilitator/cds-store'),
  cdsSettlementStore: (entity: string) => mockCdsSettlementStore(entity),
}));

import type cds from '@sap/cds';
import { gateService, type X402CapOptions } from '../../srv/middleware/cap';
import { paymentRequiredFor } from '../../srv/middleware/flow';
import { Codes } from '../../srv/core/errors';
import {
  BUYER_ADDR, BUYER_PRIV, SELLER_ADDR,
  NONCE_TX_HASH, NONCE_INDEX, NONCE_REF,
  NETWORK_PREPROD, TTL_SLOT,
} from '../fixtures/constants';
import { buildBody, signTx } from '../fixtures/build-tx';
import { buildPaymentSignature, decodeHeader } from '../fixtures/envelope';
import type { Facilitator } from '../../srv/facilitator/adapter';
import type {
  PaymentClaim,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from '../../srv/core/types';

interface FakeRes {
  setHeader: jest.Mock;
  status: jest.Mock;
  json: jest.Mock;
  headersSent: boolean;
}

interface FakeReq {
  event: string;
  target?: { name: string };
  http?: { req: { headers: Record<string, string>; originalUrl: string }; res: FakeRes };
  reject: jest.Mock;
  on: jest.Mock<void, [string, () => unknown]>;
  payment?: PaymentClaim;
}

type Before = (req: FakeReq) => Promise<unknown>;

const baseOpts = {
  payTo: SELLER_ADDR,
  network: NETWORK_PREPROD,
  asset: 'lovelace',
  priceUnits: '1000000',
};

const SETTLED: SettlementResponse = {
  success: true, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD, payer: BUYER_ADDR, amount: '1000000',
};

function fakeFacilitator() {
  return {
    verify: jest.fn<Promise<VerifyResponse>, [PaymentPayload, PaymentRequirements]>()
      .mockResolvedValue({ isValid: true, payer: BUYER_ADDR }),
    settle: jest.fn<Promise<SettlementResponse>, [PaymentPayload, PaymentRequirements]>()
      .mockResolvedValue(SETTLED),
  } satisfies Facilitator;
}

function paymentHeader(): string {
  const accepted = paymentRequiredFor(baseOpts, [{ amount: '1000000' }], '/').accepts[0]!;
  const body = buildBody({
    inputs: [{ txHash: NONCE_TX_HASH, outputIndex: NONCE_INDEX }],
    outputs: [{ address: SELLER_ADDR, lovelace: '1000000' }],
    ttlSlot: TTL_SLOT,
  });
  return buildPaymentSignature({ accepted, txCborHex: signTx(body, [BUYER_PRIV]).cborHex, nonceRef: NONCE_REF });
}

/** Register the gate on a fake service and hand back its `before` handler. */
function gate(opts: Partial<X402CapOptions>): { before: Before } {
  const handlers: Array<[string, Before]> = [];
  const srv = {
    before: (event: string, h: Before) => { handlers.push([event, h]); },
    after:  () => { throw new Error('the gate must not register an after handler'); },
  };
  gateService(srv as unknown as cds.Service, { ...baseOpts, ...opts });
  if (handlers.length !== 1 || handlers[0]![0] !== '*') throw new Error("gate did not register exactly before('*')");
  return { before: handlers[0]![1] };
}

/** What CAP does after the handler's transaction committed: run the `succeeded` listeners. */
async function commit(req: FakeReq): Promise<void> {
  for (const [event, listener] of req.on.mock.calls) {
    if (event === 'succeeded') await listener();
  }
}

function makeReq(opts: { event?: string; entity?: string; headers?: Record<string, string>; noHttp?: boolean } = {}): FakeReq {
  const res: FakeRes = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn(), headersSent: false };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return {
    event: opts.event ?? 'READ',
    ...(opts.entity ? { target: { name: `PricesService.${opts.entity}` } } : {}),
    ...(opts.noHttp ? {} : { http: { req: { headers: opts.headers ?? {}, originalUrl: '/odata/v4/prices/Quotes' }, res } }),
    reject: jest.fn(),
    on: jest.fn<void, [string, () => unknown]>(),
  };
}

const paidReq = () => makeReq({ entity: 'Quotes', headers: { 'payment-signature': paymentHeader() } });

function headerSet(req: FakeReq, name: string): string | undefined {
  const call = req.http?.res.setHeader.mock.calls.find(([k]) => k === name);
  return call?.[1] as string | undefined;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLocalFacilitator.mockImplementation(() => fakeFacilitator());
  mockDefaultFacilitator.mockReturnValue(fakeFacilitator());
});

describe('gateService, argument validation', () => {
  it.each(['payTo', 'network', 'asset'] as const)('throws without %s', (field) => {
    expect(() => gate({ [field]: '' })).toThrow(field);
  });
  it('throws without priceUnits or routePricing', () => {
    expect(() => gate({ priceUnits: undefined })).toThrow(/priceUnits or routePricing/);
  });
});

describe('gateService, default facilitator', () => {
  it('uses the process-wide default, so two gates share one facilitator', async () => {
    const shared = fakeFacilitator();
    mockDefaultFacilitator.mockReturnValue(shared);
    const a = gate({});
    const b = gate({});
    expect(mockLocalFacilitator).not.toHaveBeenCalled();
    expect(mockCdsSettlementStore).not.toHaveBeenCalled();

    await a.before(paidReq());
    await b.before(paidReq());
    expect(shared.verify).toHaveBeenCalledTimes(2);
  });

  it('builds one facilitator per settlements entity and shares it across gates', async () => {
    const perEntity = new Map<unknown, ReturnType<typeof fakeFacilitator>>();
    mockLocalFacilitator.mockImplementation((o: { store: unknown }) => {
      const f = fakeFacilitator();
      perEntity.set(o.store, f);
      return f;
    });

    const a = gate({ settlements: true });
    const b = gate({ settlements: true });
    expect(mockCdsSettlementStore).toHaveBeenCalledTimes(1);
    expect(mockCdsSettlementStore).toHaveBeenCalledWith('odatano.x402.X402Settlements');
    expect(mockLocalFacilitator).toHaveBeenCalledTimes(1);
    expect(mockLocalFacilitator).toHaveBeenCalledWith({ store: { store: 'odatano.x402.X402Settlements' } });

    const custom = gate({ settlements: { entity: 'my.Settlements' } });
    expect(mockCdsSettlementStore).toHaveBeenLastCalledWith('my.Settlements');
    expect(mockLocalFacilitator).toHaveBeenCalledTimes(2);
    expect(mockDefaultFacilitator).not.toHaveBeenCalled();

    await a.before(paidReq());
    await b.before(paidReq());
    await custom.before(paidReq());
    const [shared, own] = [...perEntity.values()];
    expect(shared!.verify).toHaveBeenCalledTimes(2);
    expect(own!.verify).toHaveBeenCalledTimes(1);
  });

  it('does not build a default when a facilitator is passed', () => {
    gate({ facilitator: fakeFacilitator(), settlements: { entity: 'unused.Settlements' } });
    expect(mockLocalFacilitator).not.toHaveBeenCalled();
    expect(mockDefaultFacilitator).not.toHaveBeenCalled();
    expect(mockCdsSettlementStore).not.toHaveBeenCalled();
  });
});

describe('gateService, before (verify)', () => {
  it('passes unmapped events through', async () => {
    const facilitator = fakeFacilitator();
    const { before } = gate({ facilitator, priceUnits: undefined, routePricing: { Quotes: '1000000' } });
    const req = makeReq({ entity: 'Free' });
    await before(req);
    expect(req.reject).not.toHaveBeenCalled();
    expect(req.on).not.toHaveBeenCalled();
  });

  it('rejects 500 when the pricing resolver throws', async () => {
    const { before } = gate({
      facilitator: fakeFacilitator(), priceUnits: undefined,
      routePricing: () => { throw new Error('pricing DB down'); },
    });
    const req = makeReq();
    await before(req);
    expect(req.reject).toHaveBeenCalledWith(500, 'x402 pricing error');
  });

  it('writes the 402 with PAYMENT-REQUIRED and rejects when no payment is attached', async () => {
    const { before } = gate({ facilitator: fakeFacilitator() });
    const req = makeReq({ entity: 'Quotes' });
    await before(req);
    const pr = decodeHeader<PaymentRequired>(headerSet(req, 'PAYMENT-REQUIRED'));
    expect(pr.resource.url).toBe('/odata/v4/prices/Quotes');
    expect(req.http!.res.status).toHaveBeenCalledWith(402);
    expect(req.http!.res.json).toHaveBeenCalledWith(pr);
    expect(req.reject).toHaveBeenCalledWith(402, JSON.stringify(pr));
    expect(req.on).not.toHaveBeenCalled();
  });

  it('only rejects when no HTTP response is reachable', async () => {
    const { before } = gate({ facilitator: fakeFacilitator() });
    const req = makeReq({ noHttp: true });
    await before(req);
    expect(req.reject).toHaveBeenCalledWith(402, expect.stringContaining('PAYMENT-SIGNATURE header is required'));
  });

  it('puts the verified claim on the request and waits for the commit to settle', async () => {
    const facilitator = fakeFacilitator();
    const { before } = gate({ facilitator });
    const req = paidReq();
    await before(req);
    expect(req.reject).not.toHaveBeenCalled();
    expect(req.on).toHaveBeenCalledTimes(1);
    expect(req.on).toHaveBeenCalledWith('succeeded', expect.any(Function));
    expect(req.payment).toMatchObject({ payTo: SELLER_ADDR, payerAddr: BUYER_ADDR, resourceUrl: '/odata/v4/prices/Quotes' });
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('rejects 402 with the code when verify fails', async () => {
    const facilitator = fakeFacilitator();
    facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: Codes.REPLAY });
    const { before } = gate({ facilitator });
    const req = paidReq();
    await before(req);
    expect(req.reject).toHaveBeenCalledWith(402, expect.stringContaining(Codes.REPLAY));
    expect(req.on).not.toHaveBeenCalled();
  });

  it('rejects 500 when verify throws', async () => {
    const facilitator = fakeFacilitator();
    facilitator.verify.mockRejectedValue(new Error('unreachable'));
    const { before } = gate({ facilitator });
    const req = paidReq();
    await before(req);
    expect(req.reject).toHaveBeenCalledWith(500, 'x402 internal error');
  });

  it('skips payment for a valid grant', async () => {
    mockLookupGrant.mockResolvedValue({ kind: 'valid' });
    const facilitator = fakeFacilitator();
    const { before } = gate({ facilitator, grants: true });
    const req = makeReq({ entity: 'Quotes', headers: { 'x-payment-grant': 'tok' } });
    await before(req);
    expect(mockLookupGrant).toHaveBeenCalledWith('odatano.x402.X402Grants', 'tok', '/odata/v4/prices/Quotes');
    expect(req.reject).not.toHaveBeenCalled();
    expect(req.on).not.toHaveBeenCalled();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('asks for payment when the grant expired', async () => {
    mockLookupGrant.mockResolvedValue({ kind: 'expired' });
    const { before } = gate({ facilitator: fakeFacilitator(), grants: true });
    const req = makeReq({ entity: 'Quotes', headers: { 'x-payment-grant': 'tok' } });
    await before(req);
    expect(req.reject).toHaveBeenCalledWith(402, expect.any(String));
  });
});

describe('gateService, settle after the commit', () => {
  it('settles nothing when the handler fails and the commit never happens', async () => {
    const facilitator = fakeFacilitator();
    const { before } = gate({ facilitator, receipts: true });
    const req = paidReq();
    await before(req);
    // no commit(req): CAP rolls back and never emits `succeeded`
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(mockPersistReceipt).not.toHaveBeenCalled();
    expect(headerSet(req, 'PAYMENT-RESPONSE')).toBeUndefined();
  });

  it('settles, sets PAYMENT-RESPONSE, persists the receipt, runs onAccepted and issues a grant', async () => {
    mockIssueGrant.mockResolvedValue({ token: 'grant-tok', expiresAt: '2030-01-01T00:00:00.000Z' });
    const facilitator = fakeFacilitator();
    facilitator.verify.mockResolvedValue({ isValid: true });
    const onAccepted = jest.fn();
    const { before } = gate({ facilitator, receipts: true, grants: true, onAccepted });
    const req = paidReq();
    await before(req);
    expect(req.payment!.payerAddr).toBeUndefined();
    await commit(req);

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(decodeHeader(headerSet(req, 'PAYMENT-RESPONSE'))).toEqual(SETTLED);
    // the settled claim replaces the verified one: the payer comes from the settlement
    expect(req.payment).toMatchObject({ payTo: SELLER_ADDR, payerAddr: BUYER_ADDR });
    expect(mockPersistReceipt).toHaveBeenCalledWith('odatano.x402.X402Receipts', req.payment, '/odata/v4/prices/Quotes');
    expect(onAccepted).toHaveBeenCalledWith(req.payment, req);
    expect(mockIssueGrant).toHaveBeenCalledWith('odatano.x402.X402Grants', req.payment, '/odata/v4/prices/Quotes', 3600);
    expect(headerSet(req, 'X-PAYMENT-GRANT')).toBe('grant-tok');
    expect(headerSet(req, 'X-PAYMENT-GRANT-EXPIRES')).toBe('2030-01-01T00:00:00.000Z');
    expect(req.reject).not.toHaveBeenCalled();
    expect(req.http!.res.status).not.toHaveBeenCalled();
  });

  it('writes receipts and grants to custom entities', async () => {
    mockIssueGrant.mockResolvedValue(null);
    const { before } = gate({
      facilitator: fakeFacilitator(),
      receipts: { entity: 'my.Receipts' },
      grants: { entity: 'my.Grants', ttlSeconds: 60 },
    });
    const req = paidReq();
    await before(req);
    await commit(req);
    expect(mockPersistReceipt).toHaveBeenCalledWith('my.Receipts', req.payment, '/odata/v4/prices/Quotes');
    expect(mockIssueGrant).toHaveBeenCalledWith('my.Grants', req.payment, '/odata/v4/prices/Quotes', 60);
    // a grant that could not be stored sets no header
    expect(headerSet(req, 'X-PAYMENT-GRANT')).toBeUndefined();
  });

  it('writes no receipt and no grant unless asked to', async () => {
    const { before } = gate({ facilitator: fakeFacilitator() });
    const req = paidReq();
    await before(req);
    await commit(req);
    expect(headerSet(req, 'PAYMENT-RESPONSE')).toBeDefined();
    expect(mockPersistReceipt).not.toHaveBeenCalled();
    expect(mockIssueGrant).not.toHaveBeenCalled();
  });

  it('keeps going when onAccepted throws', async () => {
    const { before } = gate({ facilitator: fakeFacilitator(), onAccepted: () => { throw new Error('audit down'); } });
    const req = paidReq();
    await before(req);
    await expect(commit(req)).resolves.toBeUndefined();
    expect(headerSet(req, 'PAYMENT-RESPONSE')).toBeDefined();
    expect(req.reject).not.toHaveBeenCalled();
  });

  it.each([
    ['fails', Codes.SUBMIT_FAILED, 1],
    ['stays pending', Codes.PENDING, 2],
  ])('answers 402 with both headers and rejects when settlement %s', async (_label, errorReason, settleCalls) => {
    const facilitator = fakeFacilitator();
    const failed: SettlementResponse = {
      success: false, errorReason, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD,
    };
    facilitator.settle.mockResolvedValue(failed);
    const onAccepted = jest.fn();
    const { before } = gate({ facilitator, receipts: true, grants: true, onAccepted });
    const req = paidReq();
    await before(req);
    await commit(req);

    expect(facilitator.settle).toHaveBeenCalledTimes(settleCalls);
    expect(decodeHeader(headerSet(req, 'PAYMENT-RESPONSE'))).toEqual(failed);
    const pr = decodeHeader<PaymentRequired>(headerSet(req, 'PAYMENT-REQUIRED'));
    expect(pr.error).toContain(errorReason);
    expect(req.http!.res.status).toHaveBeenCalledWith(402);
    expect(req.http!.res.json).toHaveBeenCalledWith(pr);
    expect(req.reject).toHaveBeenCalledWith(402, JSON.stringify(pr));
    expect(onAccepted).not.toHaveBeenCalled();
    expect(mockPersistReceipt).not.toHaveBeenCalled();
    expect(mockIssueGrant).not.toHaveBeenCalled();
  });

  it('only rejects a failed settlement when the HTTP response is gone', async () => {
    const facilitator = fakeFacilitator();
    facilitator.settle.mockResolvedValue({
      success: false, errorReason: Codes.SUBMIT_FAILED, transaction: '', network: NETWORK_PREPROD,
    });
    const { before } = gate({ facilitator });
    const req = paidReq();
    await before(req);
    req.http!.res.headersSent = true;
    await commit(req);
    expect(req.http!.res.status).not.toHaveBeenCalled();
    expect(req.reject).toHaveBeenCalledWith(402, expect.stringContaining(Codes.SUBMIT_FAILED));
  });

  it('rejects 500 when settle throws', async () => {
    const facilitator = fakeFacilitator();
    facilitator.settle.mockRejectedValue(new Error('network down'));
    const { before } = gate({ facilitator, receipts: true });
    const req = paidReq();
    await before(req);
    await commit(req);
    expect(req.reject).toHaveBeenCalledWith(500, 'x402 settlement error');
    expect(headerSet(req, 'PAYMENT-RESPONSE')).toBeUndefined();
    expect(mockPersistReceipt).not.toHaveBeenCalled();
  });
});
