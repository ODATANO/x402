/**
 * Pre-built `PayHandler` implementations.
 *
 * `createBridgePayHandler` is the default for server-to-server flows
 * (one CAP service calling another, AI-agent payments). It uses the
 * existing `buildUnsignedPaymentTx` helper, which requires
 * `@odatano/core` bridge access at runtime, and delegates signing
 * to a caller-supplied `signTx` callback.
 *
 * For browser CIP-30 wallets, write your own PayHandler: get UTxOs
 * from `wallet.getUtxos()`, build the tx with browser CSL, sign via
 * `wallet.signTx(cborHex, partialSign=true)` and merge the witness
 * set. (See README "Custom PayHandler" section for an example.)
 */

import { buildUnsignedPaymentTx } from '../helpers/build-unsigned-tx';
import type { PayHandler, PayHandlerResult } from './types';
import type { PaymentRequirementEntry } from '../core/types';

export interface BridgePayHandlerOptions {
  /** Buyer bech32, used for UTxO lookup and change. */
  buyerBech32: string;
  /**
   * Sign the unsigned tx CBOR. Returns the SIGNED tx CBOR hex
   * (with the vkey witness set populated).
   *
   * For server-side raw-key signing: use CSL's
   * `make_vkey_witness(txHash, privKey)` and attach it to the
   * witness set, then serialize.
   */
  signTx: (unsignedTxCborHex: string) => Promise<string>;
  /** Forwarded to `buildUnsignedPaymentTx`. Default 1800 slots ≈ 30 min. */
  ttlSlotsFromNow?: number;
}

/**
 * Build a `PayHandler` that runs the whole flow through `@odatano/core`:
 *   1. `buildUnsignedPaymentTx` (UTxO selection + tx build)
 *   2. caller-supplied `signTx` (signs the unsigned CBOR)
 *   3. returns `{ signedTxCborHex, nonceRef }`
 *
 * The signed tx is NOT submitted here, the x402 server submits it
 * after validating the envelope (per Cardano-x402-v2 facilitator flow).
 */
export function createBridgePayHandler(opts: BridgePayHandlerOptions): PayHandler {
  if (!opts.buyerBech32) {
    throw new TypeError('createBridgePayHandler: buyerBech32 is required');
  }
  if (typeof opts.signTx !== 'function') {
    throw new TypeError('createBridgePayHandler: signTx must be a function');
  }

  return async function bridgePayHandler(
    requirement: PaymentRequirementEntry,
  ): Promise<PayHandlerResult> {
    const built = await buildUnsignedPaymentTx({
      buyerBech32:     opts.buyerBech32,
      requirements:    requirement,
      ttlSlotsFromNow: opts.ttlSlotsFromNow,
    });

    const signedTxCborHex = await opts.signTx(built.unsignedTxCborHex);
    if (typeof signedTxCborHex !== 'string' || signedTxCborHex.length === 0) {
      throw new Error('createBridgePayHandler: signTx must resolve to a non-empty hex string');
    }

    return { signedTxCborHex, nonceRef: built.nonceRef };
  };
}
