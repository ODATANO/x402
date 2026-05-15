/**
 * Client-side helper types — symmetric to the server-side facilitator.
 *
 * A `PayHandler` is the one extension point: given the `accepts[]` entry
 * the user chose, it must produce a signed payment tx (CBOR hex) + the
 * v2 nonce reference. Everything else — 402-detection, retry loop,
 * envelope encoding — is generic and lives in `fetch.ts` / `axios.ts`.
 */

import type { PaymentRequirementEntry } from '../core/types';

/**
 * Signs/produces the payment for one `accepts[]` entry.
 *
 * Implementations: see `createBridgePayHandler` (server-to-server, uses
 * `@odatano/core` to build + the caller-supplied `signTx` to sign), or
 * write your own for browser CIP-30 wallets.
 */
export type PayHandler = (
  requirement: PaymentRequirementEntry,
) => Promise<PayHandlerResult>;

export interface PayHandlerResult {
  /** Hex of the **signed** payment-tx CBOR (vkey witness set populated). */
  signedTxCborHex: string;
  /**
   * v2 nonce reference `<txHash>#<outputIndex>` — must point to an
   * unspent UTxO that ALSO appears as an input of the signed tx.
   * (Server enforces both at validate time.)
   */
  nonceRef: string;
}

/** Pick which `accepts[]` entry to satisfy. Default picks the first. */
export type AcceptsSelector = (
  accepts: PaymentRequirementEntry[],
) => PaymentRequirementEntry | undefined;

export interface X402ClientOptions {
  /** Required — how to produce the signed payment tx. */
  pay: PayHandler;
  /**
   * Optional — choose one of the `accepts[]` entries when the server
   * offers multiple. Defaults to `accepts[0]`.
   */
  selectAccepts?: AcceptsSelector;
  /**
   * Maximum number of 402-driven payment retries per request. Default 1
   * — i.e. one payment attempt per request, no infinite loops.
   */
  maxRetries?: number;
}
