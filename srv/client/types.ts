/**
 * Client-side helper types, symmetric to the server-side facilitator.
 *
 * A `PayHandler` is the one extension point: given the `accepts[]` entry
 * the user chose, it must produce a signed, unbroadcast payment tx (CBOR
 * hex) and the nonce reference. 402 detection, the retry loop and the
 * `PAYMENT-SIGNATURE` encoding live in `fetch.ts` / `axios.ts`.
 */

import type { PaymentRequired, PaymentRequirements } from '../core/types';

/**
 * Signs/produces the payment for one `accepts[]` entry.
 *
 * Implementations: see `createBridgePayHandler` (server-to-server, uses
 * `@odatano/core` to build + the caller-supplied `signTx` to sign), or
 * write your own for browser CIP-30 wallets.
 */
export type PayHandler = (
  requirement: PaymentRequirements,
  paymentRequired: PaymentRequired,
) => Promise<PayHandlerResult>;

export interface PayHandlerResult {
  /** Hex of the **signed** payment-tx CBOR (vkey witness set populated). */
  signedTxCborHex: string;
  /**
   * v2 nonce reference `<txHash>#<outputIndex>`, must point to an
   * unspent UTxO that ALSO appears as an input of the signed tx.
   * (Server enforces both at validate time.)
   */
  nonceRef: string;
}

/** Pick which `accepts[]` entry to satisfy. Default: `selectFirstSupported`. */
export type AcceptsSelector = (
  accepts: PaymentRequirements[],
) => PaymentRequirements | undefined;

export interface X402ClientOptions {
  /** Required, how to produce the signed payment tx. */
  pay: PayHandler;
  /**
   * Optional, choose one of the `accepts[]` entries when the server
   * offers multiple. Default: the first entry with a supported transfer
   * method and the `authorization` payment flow.
   */
  selectAccepts?: AcceptsSelector;
  /**
   * Maximum number of 402-driven payment retries per request. Default 1
   *, i.e. one payment attempt per request, no infinite loops.
   */
  maxRetries?: number;
  /**
   * How many times to re-send the SAME `PAYMENT-SIGNATURE` after the
   * server answered 402 with `PAYMENT-RESPONSE` `settlement_pending`
   * (payment broadcast but not yet confirmed; the contract is to repeat
   * the same header, never to pay again).
   * These re-sends do NOT invoke the pay handler and do NOT count
   * against `maxRetries`. Each server-side attempt blocks in its settle
   * poll (~60s default), so total wait ≈ pendingRetries × poll budget.
   * Default 5.
   */
  pendingRetries?: number;
  /** Delay in ms between pending re-sends. Default 2000. */
  pendingRetryDelayMs?: number;
  /**
   * When `true`, throw an `X402PaymentError` after retries are
   * exhausted (or when the 402 carries no valid `PAYMENT-REQUIRED`). Default `false`:
   *
   *   - `x402Fetch` returns the last `Response` (the 402 itself).
   *   - `x402Axios` re-throws the original AxiosError.
   *
   * Pay-handler throws are ALWAYS wrapped in `X402PaymentError` (kind:
   * `'pay_handler_failed'`) regardless of this flag, with the original
   * error preserved on `.cause`.
   */
  errorOnFailure?: boolean;
}
