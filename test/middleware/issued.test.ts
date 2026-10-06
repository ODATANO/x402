import { memoryIssuedRequirementsStore } from '../../srv/middleware/issued';
import { buildRequirements } from '../../srv/core/requirements';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';

const req = (amount: string) => buildRequirements({ amount, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });

describe('memoryIssuedRequirementsStore', () => {
  it('finds an offered entry for its route, ignoring key order and network alias', async () => {
    const store = memoryIssuedRequirementsStore();
    await store.save('/r', [req('1000000'), req('2000000')], Date.now() + 60_000);
    const accepted = { ...req('2000000'), network: 'cip34:0-1' as never };
    expect(await store.find('/r', accepted)).toEqual(req('2000000'));
    expect(await store.find('/other', req('2000000'))).toBeUndefined();
    expect(await store.find('/r', req('3000000'))).toBeUndefined();
  });

  it('forgets entries after they expire', async () => {
    const store = memoryIssuedRequirementsStore();
    await store.save('/r', [req('1000000')], Date.now() - 1);
    expect(await store.find('/r', req('1000000'))).toBeUndefined();
  });
});
