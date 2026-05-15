/**
 * `localFacilitator()` should:
 *   - forward `verifyAndSettle` calls 1:1 to `process()`
 *   - expose a `supported()` advertising the v2 networks we ship
 *
 * We mock `process` at the module level so the test stays orchestration-
 * focused (full `process` behaviour is covered by verify.test.ts).
 */

jest.mock('../../srv/facilitator/verify', () => ({
  process: jest.fn(),
}));

import { localFacilitator } from '../../srv/facilitator/adapter';
import { process as processX402 } from '../../srv/facilitator/verify';
import type { PaymentRequirementsBody } from '../../srv/core/types';
import { SELLER_ADDR, NETWORK_PREPROD } from '../fixtures/constants';

const mockedProcess = processX402 as jest.MockedFunction<typeof processX402>;

const REQS: PaymentRequirementsBody = {
  x402Version: 2,
  accepts: [{
    scheme:              'exact',
    network:             NETWORK_PREPROD,
    asset:               'lovelace',
    amount:              '1000000',
    payTo:               SELLER_ADDR,
    resource:            { url: '/foo', description: '', mimeType: 'application/json' },
    assetTransferMethod: 'default',
    maxTimeoutSeconds:   600,
  }],
};

beforeEach(() => mockedProcess.mockReset());

describe('localFacilitator', () => {
  it('verifyAndSettle delegates to process()', async () => {
    mockedProcess.mockResolvedValueOnce({
      kind: 'rejected',
      code: 'wrong_recipient',
      reason: 'nope',
      requirementsBody: REQS,
    });

    const fac = localFacilitator();
    const r = await fac.verifyAndSettle({
      paymentHeader:   'aaa',
      requirementsBody: REQS,
      settlePollBudgetMs: 1234,
      allowNoTtl:      true,
    });

    expect(mockedProcess).toHaveBeenCalledTimes(1);
    expect(mockedProcess).toHaveBeenCalledWith(expect.objectContaining({
      paymentHeader:      'aaa',
      requirementsBody:   REQS,
      settlePollBudgetMs: 1234,
      allowNoTtl:         true,
    }));
    expect(r.kind).toBe('rejected');
  });

  it('supported() advertises the three v2 Cardano networks and default transfer method', async () => {
    const fac = localFacilitator();
    expect(typeof fac.supported).toBe('function');
    const s = await fac.supported!();
    expect(s.networks).toEqual(expect.arrayContaining([
      'cardano:mainnet', 'cardano:preprod', 'cardano:preview',
    ]));
    expect(s.assetTransferMethods).toContain('default');
  });
});
