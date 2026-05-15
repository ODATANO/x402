/**
 * `createBridgePayHandler` is a thin glue: it calls
 * `buildUnsignedPaymentTx` (mocked here, full coverage lives in
 * test/helpers/) and forwards to the caller-supplied `signTx`.
 *
 * We only verify the orchestration: signTx is called with the unsigned
 * CBOR returned by the builder, and the result echoes the nonceRef.
 */

jest.mock('../../srv/helpers/build-unsigned-tx', () => ({
  buildUnsignedPaymentTx: jest.fn(),
}));

import { createBridgePayHandler } from '../../srv/client/pay-handlers';
import { buildUnsignedPaymentTx } from '../../srv/helpers/build-unsigned-tx';
import {
  BUYER_ADDR, SELLER_ADDR, NONCE_REF, NETWORK_PREPROD,
} from '../fixtures/constants';
import type { PaymentRequirementEntry } from '../../srv/core/types';

const mocked = buildUnsignedPaymentTx as jest.MockedFunction<typeof buildUnsignedPaymentTx>;

const REQ: PaymentRequirementEntry = {
  scheme:              'exact',
  network:             NETWORK_PREPROD,
  asset:               'lovelace',
  amount:              '1000000',
  payTo:               SELLER_ADDR,
  resource:            { url: '/foo', description: 'X', mimeType: 'application/json' },
  assetTransferMethod: 'default',
  maxTimeoutSeconds:   600,
};

beforeEach(() => mocked.mockReset());

describe('createBridgePayHandler', () => {
  it('builds the unsigned tx, signs it, returns signedTxCborHex + nonceRef', async () => {
    mocked.mockResolvedValueOnce({
      unsignedTxCborHex: 'beef00',
      txHashHex:         'a'.repeat(64),
      requiredSignerHex: 'b'.repeat(56),
      nonceRef:          NONCE_REF,
      inputs:            [{ txHash: 'd'.repeat(64), outputIndex: 0, lovelace: '5000000' }],
      ttlSlot:           80_001_800,
    });
    const signTx = jest.fn(async (cbor: string) => cbor + 'cafe');

    const handler = createBridgePayHandler({ buyerBech32: BUYER_ADDR, signTx });
    const r = await handler(REQ);

    expect(mocked).toHaveBeenCalledWith(expect.objectContaining({
      buyerBech32:  BUYER_ADDR,
      requirements: REQ,
    }));
    expect(signTx).toHaveBeenCalledWith('beef00');
    expect(r).toEqual({ signedTxCborHex: 'beef00cafe', nonceRef: NONCE_REF });
  });

  it('forwards ttlSlotsFromNow', async () => {
    mocked.mockResolvedValueOnce({
      unsignedTxCborHex: 'aa',
      txHashHex:         'a'.repeat(64),
      requiredSignerHex: 'b'.repeat(56),
      nonceRef:          NONCE_REF,
      inputs:            [],
      ttlSlot:           1,
    });
    const handler = createBridgePayHandler({
      buyerBech32:     BUYER_ADDR,
      signTx:          async () => 'aacc',
      ttlSlotsFromNow: 3600,
    });
    await handler(REQ);
    expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ ttlSlotsFromNow: 3600 }));
  });

  it('rejects if signTx returns a non-string', async () => {
    mocked.mockResolvedValueOnce({
      unsignedTxCborHex: 'aa',
      txHashHex:         'a'.repeat(64),
      requiredSignerHex: 'b'.repeat(56),
      nonceRef:          NONCE_REF,
      inputs:            [],
      ttlSlot:           1,
    });
    const handler = createBridgePayHandler({
      buyerBech32: BUYER_ADDR,
      signTx:      async () => '' as unknown as string,
    });
    await expect(handler(REQ)).rejects.toThrow(/non-empty hex string/);
  });

  it('throws on missing buyerBech32', () => {
    expect(() => createBridgePayHandler({ buyerBech32: '', signTx: async () => 'aa' }))
      .toThrow(/buyerBech32 is required/);
  });

  it('throws on missing signTx', () => {
    expect(() => createBridgePayHandler({ buyerBech32: BUYER_ADDR, signTx: undefined as never }))
      .toThrow(/signTx must be a function/);
  });
});
