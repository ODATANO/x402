/** localFacilitator: discovery shape and delegation to verify/settle. */

import { bridgeFactory } from '../fixtures/mock-bridge';
jest.mock('../../srv/bridge', () => bridgeFactory());

import * as bridge from '../../srv/bridge';
import { localFacilitator, defaultFacilitator } from '../../srv/facilitator/adapter';
import { realParseTransaction } from '../fixtures/core-parse-mock';
import { buildRequirements } from '../../srv/core/requirements';
import { Codes } from '../../srv/core/errors';
import { SELLER_ADDR, NETWORK_PREPROD, NONCE_REF } from '../fixtures/constants';
import type { PaymentPayload } from '../../srv/core/types';

const req = buildRequirements({ amount: 2_000_000n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });
const other = buildRequirements({ amount: 3_000_000n, asset: 'lovelace', payTo: SELLER_ADDR, network: NETWORK_PREPROD });
const payload: PaymentPayload = { x402Version: 2, accepted: req, payload: { transaction: 'AAAA', nonce: NONCE_REF } };

const mocked = jest.mocked(bridge);

beforeEach(() => {
  jest.resetAllMocks();
  mocked.parseTransaction.mockImplementation(realParseTransaction as typeof bridge.parseTransaction);
});

describe('localFacilitator', () => {
  it('advertises exact on the three Cardano networks when the backend names none', async () => {
    mocked.getBackendNetwork.mockResolvedValue(null);
    const s = await localFacilitator().supported!();
    expect(s.kinds.map(k => k.network)).toEqual(['cardano:mainnet', 'cardano:preprod', 'cardano:preview']);
    for (const k of s.kinds) {
      expect(k).toMatchObject({
        x402Version: 2,
        scheme: 'exact',
        extra: { assetTransferMethods: ['default', 'script'], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } },
      });
    }
    expect(s.extensions).toEqual([]);
    expect(s.signers).toEqual({});
  });

  it.each(['cardano:mainnet', 'cardano:preprod', 'cardano:preview'])(
    'advertises only %s when the backend is on it',
    async (network) => {
      mocked.getBackendNetwork.mockResolvedValue(network);
      const s = await localFacilitator().supported!();
      expect(s.kinds).toEqual([{
        x402Version: 2,
        scheme: 'exact',
        network,
        extra: { assetTransferMethods: ['default', 'script'], areFeesSponsored: false, l1Confirmations: { minimum: 0, maximum: 20 } },
      }]);
    },
  );

  it('advertises -1 as the minimum once mempool confirmation is enabled', async () => {
    const s = await localFacilitator({ allowMempoolConfirmation: true }).supported!();
    expect(s.kinds[0]!.extra).toMatchObject({ l1Confirmations: { minimum: -1, maximum: 20 } });
  });

  it('verify answers a VerifyResponse', async () => {
    const r = await localFacilitator().verify(payload, other);
    expect(r).toMatchObject({ isValid: false, invalidReason: Codes.ACCEPTED_MISMATCH });
  });

  it('settle answers a SettlementResponse', async () => {
    const r = await localFacilitator().settle(payload, req);
    expect(r).toMatchObject({ success: false, errorReason: Codes.INVALID_CBOR, transaction: '', network: NETWORK_PREPROD });
  });

  it('builds a separate facilitator on every call', () => {
    expect(localFacilitator()).not.toBe(localFacilitator());
  });
});

describe('defaultFacilitator', () => {
  it('is the same instance on every call, so all gates share its claims', () => {
    const first = defaultFacilitator();
    expect(defaultFacilitator()).toBe(first);
    expect(defaultFacilitator()).toBe(first);
  });

  it('verifies and settles like a local facilitator', async () => {
    expect(await defaultFacilitator().verify(payload, other)).toMatchObject({ isValid: false, invalidReason: Codes.ACCEPTED_MISMATCH });
    expect(await defaultFacilitator().settle(payload, req)).toMatchObject({ success: false, errorReason: Codes.INVALID_CBOR });
  });
});
