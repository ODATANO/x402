import { selectFirstSupported } from '../../srv/client/select';
import { NETWORK_PREPROD, SELLER_ADDR } from '../fixtures/constants';
import type { PaymentExtra, PaymentRequirements } from '../../srv/core/types';

function entry(extra?: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK_PREPROD,
    asset: 'lovelace',
    amount: '1000000',
    payTo: SELLER_ADDR,
    maxTimeoutSeconds: 600,
    ...(extra ? { extra: extra as PaymentExtra } : {}),
  };
}

describe('selectFirstSupported', () => {
  it('takes the first entry with an absent method', () => {
    const plain = entry();
    expect(selectFirstSupported([plain, entry({ assetTransferMethod: 'script' })])).toBe(plain);
  });

  it('accepts script transfers', () => {
    const script = entry({ assetTransferMethod: 'script', scriptHash: '5c'.repeat(28) });
    expect(selectFirstSupported([script])).toBe(script);
  });

  it('skips unsupported transfer methods', () => {
    const plain = entry({ assetTransferMethod: 'default' });
    expect(selectFirstSupported([entry({ assetTransferMethod: 'masumi' }), plain])).toBe(plain);
  });

  it('accepts an explicit authorization flow', () => {
    const explicit = entry({ paymentFlow: 'authorization' });
    expect(selectFirstSupported([explicit])).toBe(explicit);
  });

  it('skips unknown payment flows', () => {
    const plain = entry();
    expect(selectFirstSupported([entry({ paymentFlow: 'upfront' }), entry({ paymentFlow: 'escrow' }), plain]))
      .toBe(plain);
  });

  it('returns undefined when nothing is supported', () => {
    expect(selectFirstSupported([entry({ assetTransferMethod: 'masumi' })])).toBeUndefined();
    expect(selectFirstSupported([])).toBeUndefined();
  });
});
