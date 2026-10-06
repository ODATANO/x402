/**
 * Client side of the HTTP transport: reading `PAYMENT-REQUIRED` /
 * `PAYMENT-RESPONSE` and building `PAYMENT-SIGNATURE`.
 */

import {
  encodePaymentPayload,
  isSettlementPending,
  readPaymentRequired,
  readSettlement,
} from '../../srv/client/protocol';
import { Codes } from '../../srv/core/errors';
import { decodeHeader, encodeRawPayload } from '../fixtures/envelope';
import { NETWORK_PREPROD, NONCE_REF, SELLER_ADDR } from '../fixtures/constants';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '../../srv/core/types';

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
  resource: { url: '/api/data', mimeType: 'application/json' },
  accepts: [ACCEPTED],
  extensions: { bazaar: { info: { a: 1 }, schema: {} } },
};

describe('readPaymentRequired', () => {
  it('decodes a valid header', () => {
    expect(readPaymentRequired(encodeRawPayload(REQUIRED))).toEqual(REQUIRED);
  });

  it.each([
    ['missing header', undefined],
    ['empty', ''],
    ['not base64', '%%%'],
    ['not JSON', Buffer.from('nope').toString('base64')],
    ['wrong version', encodeRawPayload({ ...REQUIRED, x402Version: 1 })],
    ['no accepts', encodeRawPayload({ ...REQUIRED, accepts: undefined })],
    ['no resource', encodeRawPayload({ ...REQUIRED, resource: undefined })],
  ])('returns undefined for %s', (_label, header) => {
    expect(readPaymentRequired(header)).toBeUndefined();
  });
});

describe('readSettlement / isSettlementPending', () => {
  it('decodes a settlement response', () => {
    const s = { success: true, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD };
    expect(readSettlement(encodeRawPayload(s))).toEqual(s);
  });

  it('returns undefined without a boolean success', () => {
    expect(readSettlement(encodeRawPayload({ transaction: '' }))).toBeUndefined();
    expect(readSettlement(null)).toBeUndefined();
  });

  it('recognizes settlement_pending only on failure', () => {
    const pending = {
      success: false, errorReason: Codes.PENDING, transaction: 'ab'.repeat(32), network: NETWORK_PREPROD,
    };
    expect(isSettlementPending(pending)).toBe(true);
    expect(isSettlementPending({ ...pending, errorReason: Codes.SUBMIT_FAILED })).toBe(false);
    expect(isSettlementPending({ ...pending, success: true })).toBe(false);
    expect(isSettlementPending(undefined)).toBe(false);
  });
});

describe('encodePaymentPayload', () => {
  const args = { paymentRequired: REQUIRED, accepted: ACCEPTED, signedTxCborHex: 'cafe', nonceRef: NONCE_REF };

  it('echoes resource, accepted and extensions verbatim', () => {
    const payload = decodeHeader<PaymentPayload>(encodePaymentPayload(args));
    expect(payload).toEqual({
      x402Version: 2,
      resource:    REQUIRED.resource,
      accepted:    ACCEPTED,
      payload:     { transaction: Buffer.from('cafe', 'hex').toString('base64'), nonce: NONCE_REF },
      extensions:  REQUIRED.extensions,
    });
  });

  it('omits extensions when the 402 had none', () => {
    const noExt: PaymentRequired = { x402Version: 2, resource: REQUIRED.resource, accepts: REQUIRED.accepts };
    const payload = decodeHeader<PaymentPayload>(encodePaymentPayload({ ...args, paymentRequired: noExt }));
    expect(payload.extensions).toBeUndefined();
  });

  it.each([
    ['non-hex tx', { signedTxCborHex: 'zz' }, /even-length hex/],
    ['odd-length tx', { signedTxCborHex: 'abc' }, /even-length hex/],
    ['bad nonce', { nonceRef: 'abc#0' }, /nonceRef/],
  ])('rejects %s', (_label, patch, msg) => {
    expect(() => encodePaymentPayload({ ...args, ...patch })).toThrow(msg);
  });
});
