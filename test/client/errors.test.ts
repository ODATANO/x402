import { X402PaymentError, paymentErrorFrom, parseErrorCode } from '../../srv/client/errors';
import { Codes } from '../../srv/core/errors';
import { NETWORK_PREPROD, SELLER_ADDR } from '../fixtures/constants';
import type { PaymentRequired, SettlementResponse } from '../../srv/core/types';

const REQUIRED: PaymentRequired = {
  x402Version: 2,
  error: `payment rejected (${Codes.WRONG_RECIPIENT}): no output to payTo`,
  resource: { url: '/r' },
  accepts: [{
    scheme: 'exact', network: NETWORK_PREPROD, asset: 'lovelace', amount: '1000000',
    payTo: SELLER_ADDR, maxTimeoutSeconds: 600,
  }],
};

describe('parseErrorCode', () => {
  it('extracts the code from the middleware error string', () => {
    expect(parseErrorCode('payment rejected (invalid_exact_cardano_payload_ttl_expired): ttl passed'))
      .toBe('invalid_exact_cardano_payload_ttl_expired');
  });

  it.each([
    'invalid_x402_version',
    'invalid_exact_cardano_payload_phase1_invalid',
    'invalid_exact_cardano_payload_phase2_invalid',
  ])('reads a code with digits: %s', (code) => {
    expect(parseErrorCode(`payment rejected (${code}): some reason`)).toBe(code);
  });

  it('returns undefined without a code', () => {
    expect(parseErrorCode('PAYMENT-SIGNATURE header is required')).toBeUndefined();
    expect(parseErrorCode(undefined)).toBeUndefined();
  });
});

describe('paymentErrorFrom', () => {
  it('builds a server_rejected error from the PaymentRequired', () => {
    const e = paymentErrorFrom(REQUIRED);
    expect(e).toBeInstanceOf(X402PaymentError);
    expect(e.kind).toBe('server_rejected');
    expect(e.code).toBe(Codes.WRONG_RECIPIENT);
    expect(e.accepts).toEqual(REQUIRED.accepts);
    expect(e.serverError).toBe(REQUIRED.error);
    expect(e.httpStatus).toBe(402);
    expect(e.message).toBe(REQUIRED.error);
  });

  it('prefers the settlement errorReason and carries the settlement', () => {
    const settlement: SettlementResponse = {
      success: false, errorReason: Codes.PENDING, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD,
    };
    const e = paymentErrorFrom(REQUIRED, { kind: 'settlement_pending', settlement, httpStatus: 402 });
    expect(e.kind).toBe('settlement_pending');
    expect(e.code).toBe(Codes.PENDING);
    expect(e.settlement).toEqual(settlement);
  });

  it('works without a PaymentRequired', () => {
    const e = paymentErrorFrom(undefined, { kind: 'retries_exhausted', cause: 'x' });
    expect(e.accepts).toBeUndefined();
    expect(e.message).toBe('payment required');
    expect(e.cause).toBe('x');
  });
});

describe('X402PaymentError', () => {
  it('keeps optional fields unset when not given', () => {
    const e = new X402PaymentError({ message: 'm', kind: 'invalid_payment_required' });
    expect(e.name).toBe('X402PaymentError');
    expect(e.code).toBeUndefined();
    expect(e.settlement).toBeUndefined();
  });
});
