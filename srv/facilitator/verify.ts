/**
 * Facilitator `/verify` for Cardano `exact`: read-only, never submits.
 *
 *   1. requirements are well-formed and supported
 *   2. `accepted` equals the requirements
 *   3. the transaction decodes
 *   4. not already settled (duplicate) by this facilitator
 *   5. structural rules (core/validate.ts)
 *   6. chain rules (chain.ts)
 */

import * as bridge from '../bridge';
import { decodePayment } from '../core/decode';
import { validatePayment, type PaymentMatch } from '../core/validate';
import { findAcceptedRequirements } from '../core/match';
import { normalizeNetwork } from '../core/network';
import { checkPaymentPayload } from '../core/payload';
import { assertConfirmationPolicy } from '../core/requirements';
import { isSupportedTransferMethod, transferMethodOf } from '../core/transfer-method';
import { Codes, X402Error, type X402Code } from '../core/errors';
import { checkOnChain } from './chain';
import type { SettlementStore, SettlementRecord } from './store';
import type {
  DecodedPayment,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from '../core/types';

export interface VerifyOutcome {
  response: VerifyResponse;
  decoded?: DecodedPayment;
  match?: PaymentMatch;
  /** The claim this facilitator already holds for the transaction, if any. */
  record?: SettlementRecord;
}

export interface VerifyContext {
  store: SettlementStore;
  /** Accept `l1Confirmations: -1` (broadcast acceptance only). */
  allowMempoolConfirmation: boolean;
}

function invalid(code: X402Code | string, reason: string): VerifyOutcome {
  return { response: { isValid: false, invalidReason: code, extra: { reason } } };
}

/** Why the facilitator cannot verify against these requirements, or null. */
export function requirementsProblem(
  r: PaymentRequirements,
  allowMempool: boolean,
): { code: X402Code; reason: string } | null {
  if (r?.scheme !== 'exact') {
    return { code: Codes.UNSUPPORTED_SCHEME, reason: `scheme '${String(r?.scheme)}' is not supported` };
  }
  if (!normalizeNetwork(r.network)) {
    return { code: Codes.INVALID_NETWORK_FORMAT, reason: `network '${String(r.network)}' is not supported` };
  }
  const method = transferMethodOf(r);
  if (!isSupportedTransferMethod(method)) {
    return { code: Codes.UNSUPPORTED_METHOD, reason: `assetTransferMethod '${method}' is not supported` };
  }
  const policy = r.extra?.confirmationPolicy;
  if (policy !== undefined) {
    try {
      assertConfirmationPolicy(policy);
    } catch (err) {
      return { code: Codes.INVALID_POLICY, reason: (err as Error).message };
    }
    if (policy.l1Confirmations === -1 && !allowMempool) {
      return { code: Codes.INVALID_POLICY, reason: 'l1Confirmations -1 is not enabled on this facilitator' };
    }
  }
  return null;
}

/** Requirements with the canonical network id, so CIP-34 aliases verify like their network. */
export function canonicalRequirements(r: PaymentRequirements): PaymentRequirements {
  const network = normalizeNetwork(r?.network);
  return network && network !== r.network ? { ...r, network } : r;
}

export async function runVerify(
  received: PaymentPayload,
  offered: PaymentRequirements,
  ctx: VerifyContext,
): Promise<VerifyOutcome> {
  const requirements = canonicalRequirements(offered);
  const problem = requirementsProblem(requirements, ctx.allowMempoolConfirmation);
  if (problem) return invalid(problem.code, problem.reason);

  let payload: PaymentPayload;
  let decoded: DecodedPayment;
  try {
    payload = checkPaymentPayload(received);
    if (!findAcceptedRequirements(payload.accepted, [requirements])) {
      return invalid(Codes.ACCEPTED_MISMATCH, 'accepted does not equal the payment requirements');
    }
    decoded = decodePayment(payload);
  } catch (err) {
    if (err instanceof X402Error) return invalid(err.code, err.message);
    throw err;
  }

  try {
    const backend = await bridge.getBackendNetwork();
    if (backend && backend !== requirements.network) {
      return invalid(Codes.INVALID_NETWORK_FORMAT, `this facilitator serves ${backend}, not ${requirements.network}`);
    }
    const record = await ctx.store.get(decoded.txHash);
    if (record?.state === 'settled') {
      return invalid(Codes.DUPLICATE_SETTLEMENT, `transaction ${decoded.txHash} is already settled`);
    }
    // A transaction this facilitator broadcast spends its own inputs, so the
    // unspent check no longer applies to it, even before an indexer shows
    // it. The TTL stops gating once the ledger has it.
    const inFlight = record?.state === 'submitting' || record?.state === 'pending';
    const alreadyAccepted = inFlight && (await bridge.getTransactionByHash(decoded.txHash)) !== null;
    const withContext = (o: VerifyOutcome): VerifyOutcome => ({ ...o, decoded, ...(record ? { record } : {}) });

    const currentSlot = await bridge.getCurrentSlot();
    const maxTtlSlot = bridge.posixToSlot(
      requirements.network,
      Date.now() + requirements.maxTimeoutSeconds * 1000,
    );
    const v = validatePayment(decoded, requirements, { currentSlot, maxTtlSlot, alreadyAccepted });
    if (!v.ok) return withContext(invalid(v.code, v.reason));

    const c = await checkOnChain(decoded, requirements, { alreadyAccepted: inFlight });
    if (!c.ok) return withContext(invalid(c.code, c.reason));

    return withContext({
      response: { isValid: true, ...(c.payerAddr ? { payer: c.payerAddr } : {}) },
      match: v.match,
    });
  } catch (err) {
    return invalid(Codes.UNEXPECTED_VERIFY_ERROR, `verify failed: ${(err as Error)?.message ?? err}`);
  }
}
