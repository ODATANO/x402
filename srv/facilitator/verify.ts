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
import { validatePayment, pickRequirement } from '../core/validate';
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
  /**
   * Pending-retry grace window (ms). Default 300_000 (5 min); 0 disables.
   *
   * Closes the pending-retry race: a buyer whose payment got a
   * `402 pending` re-sends the same envelope, but if the tx becomes
   * visible BETWEEN two re-sends, the nonce check sees the nonce as
   * spent (by this very payment) and would reject a paid buyer with
   * REPLAY forever. Within this window, an envelope whose own tx is
   * already on chain is accepted instead.
   *
   * Trade-off (deliberate): the same envelope is re-servable for up to
   * `pendingGraceMs` after its block timestamp, an implicit mini-grant,
   * semantically equivalent to the X402Grants feature. The window is
   * anchored on the server-observed `blockTime` of the tx (not the
   * buyer-controlled TTL); if the backend reports no blockTime the
   * fallback does not apply and REPLAY stands. `onAccepted` (and the
   * receipts INSERT) can fire more than once inside the window, so
   * consumers' callbacks must be idempotent on `claim.txHash`.
   */
  pendingGraceMs?: number;
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

  // ─── 1. Decode ──────────────────────────────────────────────────────
  // Decode happens BEFORE we pick a requirements entry, the picker needs
  // to know which (payTo, asset) the tx actually credits to choose
  // among multi-accept options.
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

  // Pick the accepts[] entry the buyer paid against. For single-entry
  // bodies this is the same as the old `flatRequirements`; for
  // multi-accept it routes the tx to the matching seller option.
  const picked = pickRequirement(decoded, args.requirementsBody);
  if (!picked.ok) {
    return {
      kind: 'rejected',
      code: picked.code,
      reason: picked.reason,
      requirementsBody: args.requirementsBody,
    };
  }
  const requirements = picked.entry;

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
    // Pending-retry fallback: the nonce may have been consumed by this
    // very payment tx. If the envelope's own tx is on chain and young
    // enough (server-observed blockTime within pendingGraceMs), this is
    // a paid buyer whose earlier attempt timed out in settle, not a
    // replay. See the ProcessArgs.pendingGraceMs doc for the trade-off.
    const graceMs = args.pendingGraceMs ?? 300_000;
    if (graceMs > 0) {
      let onChain: { blockTime?: number | null } | null = null;
      try {
        onChain = await bridge.getTransactionByHash(decoded.txHash) as { blockTime?: number | null } | null;
      } catch { /* backend hiccup → keep the REPLAY rejection below */ }
      const blockTime = typeof onChain?.blockTime === 'number' && onChain.blockTime > 0
        ? onChain.blockTime
        : null;
      if (blockTime != null) {
        const ageMs = Date.now() - blockTime * 1000;
        if (ageMs <= graceMs) {
          log.info(
            `pending-retry fallback: tx ${decoded.txHash} settled ${Math.max(0, Math.round(ageMs / 1000))}s ago; serving.`,
          );
          await runOnAccepted(v.claim, args.onAccepted);
          return {
            kind: 'accepted',
            txHash: v.claim.txHash,
            payment: v.claim,
            paymentResponseB64: paymentResponseHeaderB64(v.claim.network, v.claim.txHash),
          };
        }
      }
    }
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
