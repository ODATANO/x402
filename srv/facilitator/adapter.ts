/**
 * Facilitator adapter pattern.
 *
 * In v0.1 the verify+settle pipeline was hard-wired into the middlewares
 * — they imported `process()` from `verify.ts` directly. That made it
 * impossible to swap the in-process facilitator for a hosted one
 * (the pattern Coinbase uses via `@coinbase/x402`).
 *
 * v0.2 introduces this `Facilitator` interface as the single
 * extension point. Two implementations ship in-box:
 *
 *   - `localFacilitator()`  — runs verify+settle in-process via
 *                             `@odatano/core`. Default everywhere.
 *   - `httpFacilitator()`   — POSTs to a remote service (see
 *                             `srv/facilitator/http.ts` for the wire
 *                             format and `docs/facilitator-protocol.md`
 *                             for the protocol reference).
 *
 * Consumers wire their choice into the middleware:
 *
 *   x402Middleware({
 *     payTo, network, asset, priceUnits,
 *     facilitator: httpFacilitator({ url: 'https://...', apiKey }),
 *   });
 *
 * `verifyAndSettle` is the one mandatory operation — it covers the
 * entire 1.decode → 2.validate → 3.nonce → 4.settle → 5.onAccepted
 * pipeline. `supported()` is an optional discovery hook used by
 * tooling / health checks (no middleware path consumes it yet).
 */

import { process as localProcess } from './verify';
import type { ProcessArgs, ProcessResult } from './verify';
import type {
  AssetTransferMethod,
  PaymentClaim,
  PaymentRequirementsBody,
} from '../core/types';

export interface FacilitatorVerifyAndSettleArgs {
  /** Raw `PAYMENT-SIGNATURE` header value (string, array or undefined). */
  paymentHeader: string | string[] | undefined;
  /** 402 body the validator checks the payment against (`accepts[0]`). */
  requirementsBody: PaymentRequirementsBody;
  /** Settle poll budget (ms). Default 60_000. */
  settlePollBudgetMs?: number;
  /** Allow txs without a validity-range upper bound. Default false. */
  allowNoTtl?: boolean;
  /**
   * Best-effort audit callback. Invoked exactly once on `accepted`.
   * **Not transmittable over HTTP** — the http facilitator wrapper
   * invokes it locally after the remote call returns.
   */
  onAccepted?: (claim: PaymentClaim) => void | Promise<void>;
}

/** Identical to the legacy `ProcessResult` — kept as a type alias for now. */
export type FacilitatorResult = ProcessResult;

/** Discovery response — what this facilitator can handle. */
export interface FacilitatorSupportedResult {
  networks: string[];
  assetTransferMethods: AssetTransferMethod[];
}

export interface Facilitator {
  verifyAndSettle(args: FacilitatorVerifyAndSettleArgs): Promise<FacilitatorResult>;
  /** Optional discovery hook. May be omitted by minimal facilitators. */
  supported?(): Promise<FacilitatorSupportedResult>;
}

/**
 * Default in-process facilitator. Verify+settle runs locally using the
 * `@odatano/core` bridge.
 *
 * Stateless — call `localFacilitator()` once per service (or inline per
 * middleware mount); the returned object holds no per-instance state.
 */
export function localFacilitator(): Facilitator {
  return {
    verifyAndSettle: (args) => localProcess(args as ProcessArgs),
    async supported(): Promise<FacilitatorSupportedResult> {
      return {
        networks:             ['cardano:mainnet', 'cardano:preprod', 'cardano:preview'],
        assetTransferMethods: ['default'],
      };
    },
  };
}
