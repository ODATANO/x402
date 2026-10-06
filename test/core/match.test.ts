import { findAcceptedRequirements } from '../../srv/core/match';
import { SELLER_ADDR, NETWORK_PREPROD, USDM_PREPROD_ASSET } from '../fixtures/constants';
import type { PaymentRequirements } from '../../srv/core/types';

const ada: PaymentRequirements = {
  scheme: 'exact', network: NETWORK_PREPROD, asset: 'lovelace', amount: '1000000',
  payTo: SELLER_ADDR, maxTimeoutSeconds: 600, extra: { areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 1 } },
};
const usdm: PaymentRequirements = { ...ada, asset: USDM_PREPROD_ASSET, amount: '5' };

describe('findAcceptedRequirements', () => {
  it('finds the equal entry', () => {
    expect(findAcceptedRequirements({ ...usdm }, [ada, usdm])).toBe(usdm);
  });

  it('ignores object key order, nested too', () => {
    const reordered = JSON.parse(
      '{"extra":{"confirmationPolicy":{"l1Confirmations":1},"areFeesSponsored":false},"maxTimeoutSeconds":600,'
      + `"payTo":"${SELLER_ADDR}","amount":"1000000","asset":"lovelace","network":"${NETWORK_PREPROD}","scheme":"exact"}`,
    ) as PaymentRequirements;
    expect(findAcceptedRequirements(reordered, [ada])).toBe(ada);
  });

  it('treats a CIP-34 network alias as its canonical id', () => {
    const aliased = { ...ada, network: 'cip34:0-1' } as unknown as PaymentRequirements;
    expect(findAcceptedRequirements(aliased, [ada])).toBe(ada);
  });

  it.each([
    ['amount',  { amount: '999999' }],
    ['payTo',   { payTo: 'addr_test1other' }],
    ['timeout', { maxTimeoutSeconds: 601 }],
    ['extra',   { extra: { areFeesSponsored: false } }],
  ])('rejects a changed %s', (_name, change) => {
    expect(findAcceptedRequirements({ ...ada, ...change }, [ada, usdm])).toBeUndefined();
  });

  it('rejects an extra field the server did not offer', () => {
    expect(findAcceptedRequirements({ ...ada, extra: { ...ada.extra, sneaky: 1 } }, [ada])).toBeUndefined();
  });
});
