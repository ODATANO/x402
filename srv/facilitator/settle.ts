/**
 * Facilitator `/settle` for Cardano `exact`.
 *
 * Verifies, claims the transaction id, submits, then waits (bounded) for
 * the evidence `confirmationPolicy` requires. Below the threshold it
 * answers `settlement_pending`; a retry with the same payload takes the
 * claim over and resumes. A transaction a backend took is never submitted
 * again. A second settle of a settled or in-progress transaction answers
 * `duplicate_settlement`.
 */

import cds from '@sap/cds';
import * as bridge from '../bridge';
import { decodePayment } from '../core/decode';
import { Codes, X402Error } from '../core/errors';
import { findAcceptedRequirements } from '../core/match';
import { matchOutput } from '../core/validate';
import { checkPaymentPayload } from '../core/payload';
import { runVerify, canonicalRequirements, type VerifyContext } from './verify';
import { isResumable, type SettlementRecord } from './store';
import type {
  DecodedPayment,
  PaymentPayload,
  PaymentRequirements,
  SettlementEvidence,
  SettlementResponse,
} from '../core/types';

const log = cds.log('x402');

/** Indexer lag after the TTL before a missing transaction counts as never landed. */
const EXPIRY_GRACE_MS = 120_000;

/** How long past its wait a settle call keeps the claim before a retry may take over. */
const LEASE_MARGIN_MS = 30_000;

export interface SettleContext extends VerifyContext {
  /** How long one settle call waits for the required evidence. */
  pollBudgetMs: number;
  pollIntervalMs: number;
  /** Kept past the TTL so a late claim cannot reopen a settled transaction. */
  claimGraceMs: number;
}

function response(
  requirements: PaymentRequirements,
  fields: Omit<SettlementResponse, 'network'>,
): SettlementResponse {
  return { ...fields, network: requirements.network };
}

function failure(requirements: PaymentRequirements, errorReason: string, transaction = '', payer?: string): SettlementResponse {
  return response(requirements, {
    success: false,
    errorReason,
    transaction,
    ...(payer ? { payer } : {}),
  });
}

type Observation =
  | { kind: 'reached'; evidence: SettlementEvidence }
  | { kind: 'waiting'; evidence: SettlementEvidence }
  /** The validity window closed and the transaction never landed. */
  | { kind: 'expired' }
  /** It landed as a failed script run: collateral taken, payment output not created. */
  | { kind: 'scriptFailed' };

/** Polls until the policy is met, the budget runs out, or the transaction can no longer pay. */
async function observe(
  decoded: DecodedPayment,
  requirements: PaymentRequirements,
  required: number,
  ctx: SettleContext,
): Promise<Observation> {
  const deadline = Date.now() + ctx.pollBudgetMs;
  let evidence: SettlementEvidence = { status: 'pending', confirmations: -1, transactionId: decoded.txHash };
  for (;;) {
    const tx = await bridge.getTransactionByHash(decoded.txHash);
    if (tx?.spendsCollaterals === true) return { kind: 'scriptFailed' };
    if (tx && typeof tx.blockHeight === 'number') {
      const confirmations = Math.max(0, (await bridge.getTipHeight()) - tx.blockHeight);
      evidence = { status: 'confirmed', confirmations, transactionId: decoded.txHash };
      if (confirmations >= required) return { kind: 'reached', evidence };
    } else if (
      decoded.ttlSlot !== null
      && Date.now() > bridge.slotToPosixMs(requirements.network, decoded.ttlSlot) + EXPIRY_GRACE_MS
    ) {
      return { kind: 'expired' };
    }
    if (Date.now() + ctx.pollIntervalMs > deadline) {
      return { kind: 'waiting', evidence: { ...evidence, status: 'pending' } };
    }
    await new Promise(r => setTimeout(r, ctx.pollIntervalMs));
  }
}

export async function runSettle(
  payload: PaymentPayload,
  offered: PaymentRequirements,
  ctx: SettleContext,
): Promise<SettlementResponse> {
  const requirements = canonicalRequirements(offered);
  let decoded: DecodedPayment;
  try {
    decoded = decodePayment(checkPaymentPayload(payload));
  } catch (err) {
    if (err instanceof X402Error) return failure(requirements, err.code);
    throw err;
  }
  const txId = decoded.txHash;
  const required = requirements.extra?.confirmationPolicy?.l1Confirmations ?? 1;
  const leaseUntil = () => Date.now() + ctx.pollBudgetMs + LEASE_MARGIN_MS;
  let amount: string | undefined;

  /**
   * Take over a record nobody works on, or refuse. A record another call
   * holds, or a settled one, is a second delivery attempt. A resumed
   * transaction must still pay these requirements.
   */
  const takeOver = async (record: SettlementRecord): Promise<SettlementResponse | null> => {
    const payer = record.response?.payer;
    if (record.state === 'failed' && record.response) return record.response;
    if (isResumable(record)) {
      if (!findAcceptedRequirements(payload.accepted, [requirements])) {
        return failure(requirements, Codes.ACCEPTED_MISMATCH, txId, payer);
      }
      const paid = matchOutput(decoded, requirements);
      if (!paid.ok) return failure(requirements, paid.code, txId, payer);
      amount = paid.match.amountUnits;
      if (await ctx.store.resume(txId, leaseUntil())) return null;
    }
    return failure(requirements, Codes.DUPLICATE_SETTLEMENT, txId, payer);
  };

  let holding = false;
  let payer: string | undefined;
  try {
    let record = await ctx.store.get(txId);
    if (!record) {
      const v = await runVerify(payload, requirements, ctx);
      if (!v.response.isValid) {
        return failure(requirements, v.response.invalidReason ?? Codes.UNEXPECTED_SETTLE_ERROR, '', v.response.payer);
      }
      payer = v.response.payer;
      amount = v.match?.amountUnits;
      const ttlMs = bridge.slotToPosixMs(requirements.network, decoded.ttlSlot!);
      const claim = await ctx.store.claim(txId, ttlMs + ctx.claimGraceMs, leaseUntil());
      if (!claim.claimed) record = claim.record;
    }
    if (record) {
      const refused = await takeOver(record);
      if (refused) return refused;
      payer ??= record.response?.payer;
    }
    holding = true;

    // A transaction no backend is known to have taken is submitted (again):
    // the same bytes are harmless twice, and otherwise it could never land.
    let broadcast = record?.broadcast ?? false;
    if (!broadcast) {
      const submitted = await bridge.trySubmit(decoded.txCborHex);
      if (submitted.kind === 'unknown') {
        log.warn(`submit of ${txId} had no clear answer, observing: ${submitted.reason}`);
      } else if (submitted.kind === 'rejected' && !(await bridge.getTransactionByHash(txId))) {
        log.warn(`ledger refused ${txId}: ${submitted.reason}`);
        await ctx.store.release(txId);
        holding = false;
        return failure(requirements, Codes.SUBMIT_FAILED, '', payer);
      } else {
        broadcast = true;
        await ctx.store.update(txId, { broadcast: true });
      }
    }

    const base = {
      transaction: txId,
      ...(payer ? { payer } : {}),
      ...(amount ? { amount } : {}),
    };

    // `-1` accepts the broadcast itself; without a clear answer to the
    // submit, wait for the block instead.
    if (required === -1 && broadcast) {
      const done = response(requirements, {
        success: true, ...base, extra: { status: 'mempool', confirmations: -1, transactionId: txId },
      });
      await ctx.store.update(txId, { state: 'settled', response: done });
      return done;
    }

    const o = await observe(decoded, requirements, Math.max(required, 0), ctx);
    if (o.kind === 'reached') {
      const done = response(requirements, { success: true, ...base, extra: o.evidence });
      await ctx.store.update(txId, { state: 'settled', response: done });
      return done;
    }
    if (o.kind === 'expired' || o.kind === 'scriptFailed') {
      const code = o.kind === 'expired' ? Codes.SETTLEMENT_FAILED : Codes.PHASE2_INVALID;
      const failed = failure(requirements, code, txId, payer);
      await ctx.store.update(txId, { state: 'failed', response: failed });
      return failed;
    }
    const pending = response(requirements, {
      success: false, errorReason: Codes.PENDING, ...base, extra: o.evidence,
    });
    await ctx.store.update(txId, { state: 'pending', response: pending });
    return pending;
  } catch (err) {
    log.error('settle failed', err);
    if (!holding) return failure(requirements, Codes.UNEXPECTED_SETTLE_ERROR, '');
    // The transaction may be on its way. The claim goes back to `pending`
    // and the answer says so, so the buyer re-sends the same header and a
    // retry resumes it.
    const pending = response(requirements, {
      success: false,
      errorReason: Codes.PENDING,
      transaction: txId,
      ...(payer ? { payer } : {}),
      extra: { status: 'pending', confirmations: -1, transactionId: txId },
    });
    await ctx.store.update(txId, { state: 'pending', response: pending }).catch(() => undefined);
    return pending;
  }
}
