/**
 * Pure unit tests for `X402PaymentError` and its helpers.
 */

import {
  X402PaymentError,
  parseErrorCode,
  paymentErrorFromBody,
} from '../../srv/client/errors';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';
import type { PaymentRequirementsBody } from '../../srv/core/types';

const REQS: PaymentRequirementsBody = {
  x402Version: 2,
  error: 'payment required (wrong_recipient): no output paid to addr_test1...',
  accepts: [{
    scheme:              'exact',
    network:             NETWORK_PREPROD,
    asset:               'lovelace',
    amount:              '1000000',
    payTo:               SELLER_ADDR,
    resource:            { url: '/r', description: '', mimeType: 'application/json' },
    assetTransferMethod: 'default',
    maxTimeoutSeconds:   600,
  }],
};

describe('X402PaymentError', () => {
  it('captures all init fields and is instanceof Error', () => {
    const cause = new Error('inner');
    const e = new X402PaymentError({
      message: 'x', kind: 'pay_handler_failed', code: 'wallet_cancelled',
      accepts: REQS.accepts, httpStatus: 402, serverError: 'srv', cause,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(X402PaymentError);
    expect(e.name).toBe('X402PaymentError');
    expect(e.kind).toBe('pay_handler_failed');
    expect(e.code).toBe('wallet_cancelled');
    expect(e.accepts).toHaveLength(1);
    expect(e.httpStatus).toBe(402);
    expect(e.serverError).toBe('srv');
    expect(e.cause).toBe(cause);
  });

  it('leaves unset optional fields as undefined', () => {
    const e = new X402PaymentError({ message: 'm', kind: 'invalid_402_body' });
    expect(e.code).toBeUndefined();
    expect(e.cause).toBeUndefined();
    expect(e.accepts).toBeUndefined();
    expect(e.httpStatus).toBeUndefined();
    expect(e.serverError).toBeUndefined();
  });
});

describe('parseErrorCode', () => {
  it('extracts a snake_case code in parentheses', () => {
    expect(parseErrorCode('payment required (wrong_recipient): nope')).toBe('wrong_recipient');
  });
  it('returns undefined when no parenthesised code', () => {
    expect(parseErrorCode('PAYMENT-SIGNATURE header is required')).toBeUndefined();
  });
  it('returns undefined for empty / missing input', () => {
    expect(parseErrorCode(undefined)).toBeUndefined();
    expect(parseErrorCode('')).toBeUndefined();
  });
});

describe('paymentErrorFromBody', () => {
  it('produces a server_rejected error by default', () => {
    const e = paymentErrorFromBody(REQS);
    expect(e.kind).toBe('server_rejected');
    expect(e.code).toBe('wrong_recipient');
    expect(e.serverError).toBe(REQS.error);
    expect(e.accepts).toHaveLength(1);
    expect(e.httpStatus).toBe(402);
  });

  it('honours retries_exhausted kind', () => {
    const e = paymentErrorFromBody(REQS, { kind: 'retries_exhausted' });
    expect(e.kind).toBe('retries_exhausted');
  });

  it('preserves cause when supplied', () => {
    const cause = new Error('original');
    const e = paymentErrorFromBody(REQS, { cause });
    expect(e.cause).toBe(cause);
  });
});
