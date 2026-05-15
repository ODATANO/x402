/**
 * The facilitator orchestrator: end-to-end pipeline from raw header to
 * an `accepted | rejected | pending` outcome.
 *
 * Pipeline (v2):
 *   1. decode               (PAYMENT-SIGNATURE → DecodedPayment)
 *   2. validate             (6 mandatory checks, pure)
 *   3. checkNonceUnspent    (chain, UTxO still spendable)
 *   4. settle               (submit + poll-until-confirmed)
 *   5. onAccepted callback  (consumer-side audit, best-effort)
 *
 * Order rationale:
 *   - `validate` runs the input-side (5a) BEFORE `checkNonceUnspent`
 *     does the chain-side (5b), so we avoid the round-trip for txs
 *     whose inputs don't include the claimed nonce.
 *   - `checkNonceUnspent` runs BEFORE `settle`, because submitting a
 *     CBOR whose nonce was already spent will fail at the network
 *     level anyway, and we want to return a precise REPLAY code
 *     instead of a generic SUBMIT_FAILED.
 *   - `onAccepted` runs ONLY after settle confirms, we never call it
 *     for pending/rejected outcomes.
 */

import cds from '@sap/cds';
import { decode } from '../core/decode';
import { validatePayment } from '../core/validate';
import { flatRequirements } from '../core/requirements';
import { Codes, X402Error, type X402Code } from '../core/errors';
import { checkNonceUnspent } from './nonce';
import { settle, type SettleArgs } from './settle';
import * as bridge from '../bridge';
import type {
  PaymentClaim,
  PaymentRequirementsBody,
} from '../core/types';

const log = cds.log('x402');

export type ProcessKind = 'accepted' | 'rejected' | 'pending';

export interface ProcessArgs {
  /** Raw header value (undefined if missing). */
  paymentHeader: string | string[] | undefined;
  /** Full 402 body, the validator inspects `accepts[0]`. */
  requirementsBody: PaymentRequirementsBody;
  /** Optional override of the settle poll budget (ms). Default 60_000. */
  settlePollBudgetMs?: number;
  /**
   * Optional: callback invoked on successful payment. Use for consumer-
   * side audit (e.g. CHAINFEED writing to FeedReads, ODATAPAY writing to
   * Receipts). Throws here are swallowed and logged, the canonical
   * record is on chain.
   */
  onAccepted?: (claim: PaymentClaim) => void | Promise<void>;
  /**
   * Optional: TTL check tolerance. Default false, txs without a
   * validity-range upper bound are rejected.
   */
  allowNoTtl?: boolean;
}

export type ProcessResult =
  | {
      kind: 'accepted';
      txHash: string;
      payment: PaymentClaim;
      /** base64 of `{ success: true, network, transaction }` for X-PAYMENT-RESPONSE header. */
      paymentResponseB64: string;
    }
  | {
      kind: 'rejected';
      code: X402Code;
      reason: string;
      requirementsBody: PaymentRequirementsBody;
    }
  | {
      kind: 'pending';
      code: X402Code;
      reason?: string;
      txHash?: string;
      requirementsBody: PaymentRequirementsBody;
    };

function paymentResponseHeaderB64(network: string, txHash: string): string {
  return Buffer.from(JSON.stringify({
    success: true, network, transaction: txHash,
  }), 'utf8').toString('base64');
}

async function runOnAccepted(
  claim: PaymentClaim,
  cb: ProcessArgs['onAccepted'],
): Promise<void> {
  if (!cb) return;
  try {
    await cb(claim);
  } catch (err) {
    log.warn(
      'onAccepted callback failed (non-fatal):',
      (err as { message?: string })?.message ?? err,
    );
  }
}

export async function process(args: ProcessArgs): Promise<ProcessResult> {
  const headerStr = Array.isArray(args.paymentHeader)
    ? args.paymentHeader[0]
    : args.paymentHeader;

  if (!headerStr) {
    return {
      kind: 'rejected',
      code: Codes.MISSING_HEADER,
      reason: 'PAYMENT-SIGNATURE header is required',
      requirementsBody: args.requirementsBody,
    };
  }

  const requirements = flatRequirements(args.requirementsBody);

  // ─── 1. Decode ──────────────────────────────────────────────────────
  let decoded;
  try {
    decoded = decode(headerStr);
  } catch (err) {
    if (err instanceof X402Error) {
      return {
        kind: 'rejected',
        code: err.code as X402Code,
        reason: err.message,
        requirementsBody: args.requirementsBody,
      };
    }
    throw err;
  }

  // ─── 2. Validate (6 checks, pure) ───────────────────────────────────
  let currentSlot: number;
  try {
    currentSlot = await bridge.getCurrentSlot();
  } catch (err) {
    return {
      kind: 'rejected',
      code: (err as X402Error).code as X402Code ?? Codes.BRIDGE_UNAVAILABLE,
      reason: `bridge.getCurrentSlot failed: ${(err as Error)?.message ?? err}`,
      requirementsBody: args.requirementsBody,
    };
  }

  const v = validatePayment(decoded, requirements, {
    currentSlot,
    allowNoTtl: args.allowNoTtl,
  });
  if (!v.ok) {
    return {
      kind: 'rejected',
      code: v.code,
      reason: v.reason,
      requirementsBody: args.requirementsBody,
    };
  }

  // ─── 3. Nonce, UTxO still unspent (chain) ──────────────────────────
  const nonceResult = await checkNonceUnspent({
    txHash:      decoded.nonce.txHash,
    outputIndex: decoded.nonce.index,
  });
  if (!nonceResult.ok) {
    return {
      kind: 'rejected',
      code: nonceResult.code,
      reason: nonceResult.reason,
      requirementsBody: args.requirementsBody,
    };
  }

  // ─── 4. Settle (submit + poll-until-confirmed) ──────────────────────
  const settleArgs: SettleArgs = {
    signedTxCborHex: decoded.txCborHex,
    expectedTxHash:  decoded.txHash,
  };
  if (args.settlePollBudgetMs !== undefined) {
    settleArgs.pollBudgetMs = args.settlePollBudgetMs;
  }
  const settled = await settle(settleArgs);
  if (!settled.confirmed) {
    if (settled.pending) {
      return {
        kind: 'pending',
        code: settled.code ?? Codes.PENDING,
        ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
        ...(settled.txHash !== undefined ? { txHash: settled.txHash } : {}),
        requirementsBody: args.requirementsBody,
      };
    }
    return {
      kind: 'rejected',
      code: settled.code ?? Codes.SUBMIT_FAILED,
      reason: settled.reason ?? 'submit failed',
      requirementsBody: args.requirementsBody,
    };
  }

  // ─── 5. onAccepted (consumer audit, best-effort) ────────────────────
  await runOnAccepted(v.claim, args.onAccepted);

  // ─── 6. Success ─────────────────────────────────────────────────────
  return {
    kind: 'accepted',
    txHash: v.claim.txHash,
    payment: v.claim,
    paymentResponseB64: paymentResponseHeaderB64(v.claim.network, v.claim.txHash),
  };
}
