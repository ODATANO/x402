/**
 * Resource-server side of the `authorization` payment flow, shared by the
 * Express and CAP integrations:
 *
 *   startPayment:  402 with `PAYMENT-REQUIRED`, or parse `PAYMENT-SIGNATURE`,
 *                  match `accepted`, facilitator `verify`, `verifyTransfer`
 *   (the protected handler runs)
 *   finishPayment: facilitator `settle`; `PAYMENT-RESPONSE` either way
 *
 * A handler that fails is never settled, so the buyer is not charged.
 */

import { buildPaymentRequired, type BuildPaymentRequiredArgs } from '../core/requirements';
import { parsePaymentPayload } from '../core/payload';
import { decodePayment } from '../core/decode';
import { findAcceptedRequirements } from '../core/match';
import { matchOutput, buildClaim, type PaymentMatch } from '../core/validate';
import { encodeBase64Json } from '../core/base64';
import { Codes, MALFORMED_CODES, X402Error } from '../core/errors';
import type { Facilitator } from '../facilitator/adapter';
import type { IssuedRequirementsStore } from './issued';
import type {
  ConfirmationPolicy,
  DecodedPayment,
  Extensions,
  PaymentClaim,
  PaymentExtra,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  RouteOption,
  SettlementResponse,
} from '../core/types';

export interface TransferCheckContext {
  decoded: DecodedPayment;
  /** The `accepts[]` entry the payment matched. */
  requirement: PaymentRequirements;
}

export type TransferCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Resource-server check on the payment tx after the facilitator verified
 * it, e.g. the inline datum of a `script` lock. A rejection answers 402
 * `transfer_rejected`; a throw surfaces as a server error.
 */
export type VerifyTransfer = (ctx: TransferCheckContext) => TransferCheckResult | Promise<TransferCheckResult>;

/** Options both integrations share. */
export interface PaymentGateOptions {
  /** Bech32 recipient. */
  payTo: string;
  network: string;
  /** `'lovelace'` or `<policy>.<nameHex>`. */
  asset: string;
  /** `ResourceInfo.description`. */
  description?: string;
  /** `ResourceInfo.mimeType`; default 'application/json' */
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  /** default 600 */
  maxTimeoutSeconds?: number;
  extra?: PaymentExtra;
  confirmationPolicy?: ConfirmationPolicy;
  extensions?: Extensions;
  verifyTransfer?: VerifyTransfer;
  /**
   * Remember offered requirements and match the paid retry against them.
   * Needed when a route's requirements differ per request; without it the
   * requirements must be the same on the retry.
   */
  issuedRequirements?: IssuedRequirementsStore;
}

export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** A verified payment waiting for its handler to finish. */
export interface PaymentSession {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  paymentRequired: PaymentRequired;
  decoded: DecodedPayment;
  match: PaymentMatch;
  /** Verified, not yet settled. */
  claim: PaymentClaim;
}

export type StartResult =
  | { kind: 'answer'; answer: HttpAnswer }
  | { kind: 'proceed'; session: PaymentSession };

export type FinishResult =
  | { kind: 'settled'; claim: PaymentClaim; headers: Record<string, string> }
  | { kind: 'answer'; answer: HttpAnswer };

const MISSING_HEADER_ERROR = 'PAYMENT-SIGNATURE header is required';

function resourceOf(opts: PaymentGateOptions, url: string): ResourceInfo {
  return {
    url,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    mimeType: opts.mimeType ?? 'application/json',
    ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    ...(opts.iconUrl !== undefined ? { iconUrl: opts.iconUrl } : {}),
  };
}

/** The `PaymentRequired` of a request. */
export function paymentRequiredFor(opts: PaymentGateOptions, options: RouteOption[], resourceUrl: string): PaymentRequired {
  const args: BuildPaymentRequiredArgs = {
    options,
    payTo:    opts.payTo,
    network:  opts.network,
    asset:    opts.asset,
    resource: resourceOf(opts, resourceUrl),
    ...(opts.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}),
    ...(opts.extra !== undefined ? { extra: opts.extra } : {}),
    ...(opts.confirmationPolicy !== undefined ? { confirmationPolicy: opts.confirmationPolicy } : {}),
    ...(opts.extensions !== undefined ? { extensions: opts.extensions } : {}),
  };
  return buildPaymentRequired(args);
}

/** 402 (or 400) answer carrying `PAYMENT-REQUIRED`; the body repeats it for clients that read bodies. */
export function requiredAnswer(
  paymentRequired: PaymentRequired,
  error: string,
  status = 402,
  extraHeaders: Record<string, string> = {},
): HttpAnswer {
  const pr: PaymentRequired = { ...paymentRequired, error };
  return {
    status,
    headers: { 'PAYMENT-REQUIRED': encodeBase64Json(pr), ...extraHeaders },
    body: pr,
  };
}

function errorText(code: string, reason?: string): string {
  return `payment rejected (${code})${reason ? `: ${reason}` : ''}`;
}

export async function startPayment(
  opts: PaymentGateOptions,
  facilitator: Facilitator,
  options: RouteOption[],
  resourceUrl: string,
  paymentHeader: string | undefined,
): Promise<StartResult> {
  const paymentRequired = paymentRequiredFor(opts, options, resourceUrl);
  const answer = (code: string, reason?: string, status?: number): StartResult => ({
    kind: 'answer',
    answer: requiredAnswer(paymentRequired, errorText(code, reason), status ?? (MALFORMED_CODES.has(code) ? 400 : 402)),
  });

  if (!paymentHeader) {
    if (opts.issuedRequirements) {
      const longest = Math.max(...paymentRequired.accepts.map(r => r.maxTimeoutSeconds));
      await opts.issuedRequirements.save(resourceUrl, paymentRequired.accepts, Date.now() + longest * 1000);
    }
    return { kind: 'answer', answer: requiredAnswer(paymentRequired, MISSING_HEADER_ERROR) };
  }

  let payload: PaymentPayload;
  let decoded: DecodedPayment;
  try {
    payload = parsePaymentPayload(paymentHeader);
    decoded = decodePayment(payload);
  } catch (err) {
    if (err instanceof X402Error) return answer(err.code, err.message);
    throw err;
  }

  const requirements = findAcceptedRequirements(payload.accepted, paymentRequired.accepts)
    ?? await opts.issuedRequirements?.find(resourceUrl, payload.accepted);
  if (!requirements) {
    return answer(Codes.ACCEPTED_MISMATCH, 'accepted is not one of the offered payment requirements');
  }

  const verified = await facilitator.verify(payload, requirements);
  if (!verified.isValid) {
    const reason = typeof verified.extra?.reason === 'string' ? verified.extra.reason : undefined;
    return answer(verified.invalidReason ?? Codes.UNEXPECTED_VERIFY_ERROR, reason);
  }

  const matched = matchOutput(decoded, requirements);
  if (!matched.ok) return answer(matched.code, matched.reason);

  if (opts.verifyTransfer) {
    const t = await opts.verifyTransfer({ decoded, requirement: requirements });
    if (!t.ok) return answer(Codes.TRANSFER_REJECTED, t.reason, 402);
  }

  return {
    kind: 'proceed',
    session: {
      payload,
      requirements,
      paymentRequired,
      decoded,
      match: matched.match,
      claim: buildClaim(decoded, requirements, matched.match, resourceUrl, verified.payer),
    },
  };
}

export async function finishPayment(facilitator: Facilitator, session: PaymentSession): Promise<FinishResult> {
  let settled: SettlementResponse = await facilitator.settle(session.payload, session.requirements);
  // Like other x402 resource servers, settle once more before surfacing a
  // pending payment: many clients do not re-send on a pending 402.
  if (!settled.success && settled.errorReason === Codes.PENDING) {
    settled = await facilitator.settle(session.payload, session.requirements);
  }
  const responseHeader = { 'PAYMENT-RESPONSE': encodeBase64Json(settled) };
  if (settled.success) {
    const claim = settled.payer && !session.claim.payerAddr
      ? { ...session.claim, payerAddr: settled.payer }
      : session.claim;
    return { kind: 'settled', claim, headers: responseHeader };
  }
  return {
    kind: 'answer',
    answer: requiredAnswer(
      session.paymentRequired,
      errorText(settled.errorReason ?? Codes.UNEXPECTED_SETTLE_ERROR),
      402,
      responseHeader,
    ),
  };
}
