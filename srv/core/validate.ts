/**
 * Validate a decoded payment against payment requirements.
 *
 * Implements the **6 mandatory facilitator checks** from
 * Cardano-x402-v2:
 *
 *   1. Network validation
 *   2. Recipient verification          , ≥1 output to payTo
 *   3. Amount verification             , sum of payTo outputs for asset ≥ required
 *   4. Asset verification              , exact policy + name match
 *   5. Nonce / replay prevention
 *      - 5a. UTxO referenced by `payload.nonce` appears as a tx input
 *      - 5b. that UTxO is still unspent on chain  ← chain-touching, lives in `nonce.ts`
 *   6. TTL / expiry                    , tx.validity_range.upper_bound in future
 *
 * This module covers (1), (2), (3), (4), (5a) and (6). The chain-touching
 * part of (5), checking the UTxO is unspent, and (5b) live in
 * `facilitator/nonce.ts` and run after this. We also keep a sanity guard
 * for "no vkey witnesses" so an unsigned CBOR is rejected with a precise
 * code rather than blowing up at submit time.
 *
 * Pure function. No I/O.
 */

import { Codes, type X402Code } from './errors';
import { networksMatch } from './network';
import { parseAsset } from './asset';
import type {
  DecodedPayment,
  DecodedOutput,
  PaymentRequirementEntry,
  PaymentRequirementsBody,
  PaymentClaim,
  Network,
} from './types';

export type ValidationResult =
  | { ok: true; claim: PaymentClaim }
  | { ok: false; code: X402Code; reason: string };

export interface ValidateOptions {
  /** Required: current slot, for TTL upper-bound check. */
  currentSlot: number;
  /**
   * If true, allow tx with no `ttl()` set (validity-range upper bound
   * absent). Default false, v2 spec recommends a TTL. Callers that
   * want to accept no-TTL txs (e.g. legacy wallets) opt-in.
   */
  allowNoTtl?: boolean;
}

function quantityOf(output: DecodedOutput, isLovelace: boolean, unit: string): bigint {
  if (isLovelace) return BigInt(output.lovelace);
  const a = output.assets.find(x => x.unit === unit);
  return a ? BigInt(a.quantity) : 0n;
}

/**
 * Total amount of `unit` paid to `payTo`, summed across ALL matching
 * outputs. Summing is correct: a wallet may split a payment across
 * multiple outputs (e.g. token + change), and we credit the full amount
 * sent to our address.
 */
function totalPaid(
  decoded: DecodedPayment,
  payTo: string,
  isLovelace: boolean,
  unit: string,
): { total: bigint; anyOutputToRecipient: boolean } {
  let total = 0n;
  let anyOutputToRecipient = false;
  for (const o of decoded.outputs) {
    if (o.address !== payTo) continue;
    anyOutputToRecipient = true;
    total += quantityOf(o, isLovelace, unit);
  }
  return { total, anyOutputToRecipient };
}

export function validatePayment(
  decoded: DecodedPayment,
  requirements: PaymentRequirementEntry,
  opts: ValidateOptions,
): ValidationResult {
  // ─── Sanity: witness present ───────────────────────────────────────
  // An unsigned CBOR can't be submitted. Catch this here with a precise
  // code rather than letting the submit step fail with a generic 400.
  if (!decoded.vkeyWitnessCount || decoded.vkeyWitnessCount < 1) {
    return {
      ok: false,
      code: Codes.UNSIGNED_TRANSACTION,
      reason: 'transaction has no vkey witnesses',
    };
  }

  // ─── Check 1: network ──────────────────────────────────────────────
  if (!networksMatch(decoded.envelope.network, requirements.network)) {
    return {
      ok: false,
      code: Codes.NETWORK_MISMATCH,
      reason: `payment network '${decoded.envelope.network}' does not match requirements '${requirements.network}'`,
    };
  }

  // Parse the asset string once, also normalises the requirement's
  // unit key for output comparison.
  const parsed = parseAsset(requirements.asset);
  const unit = parsed.unit; // empty when lovelace; checks short-circuit via isLovelace
  const required = BigInt(requirements.amount);

  const { total: paid, anyOutputToRecipient } = totalPaid(
    decoded, requirements.payTo, parsed.isLovelace, unit,
  );

  // ─── Check 2: recipient ────────────────────────────────────────────
  if (!anyOutputToRecipient) {
    return {
      ok: false,
      code: Codes.WRONG_RECIPIENT,
      reason: `no output to payTo address ${requirements.payTo}`,
    };
  }

  // ─── Check 4: asset (run before amount so amount=0 reports as
  //              WRONG_ASSET rather than INSUFFICIENT_AMOUNT) ─────────
  if (paid === 0n) {
    return {
      ok: false,
      code: Codes.WRONG_ASSET,
      reason: `outputs to payTo do not contain asset ${requirements.asset}`,
    };
  }

  // ─── Check 3: amount ───────────────────────────────────────────────
  if (paid < required) {
    return {
      ok: false,
      code: Codes.INSUFFICIENT_AMOUNT,
      reason: `paid ${paid.toString()} < required ${required.toString()} of asset ${requirements.asset}`,
    };
  }

  // ─── Check 5a: nonce UTxO appears in tx inputs ─────────────────────
  // (5b, UTxO is unspent, runs in facilitator/nonce.ts after we've
  // confirmed the buyer's structural intent here.)
  const nonceInInputs = decoded.inputs.some(
    i => i.txHash === decoded.nonce.txHash && i.outputIndex === decoded.nonce.index,
  );
  if (!nonceInInputs) {
    return {
      ok: false,
      code: Codes.NONCE_NOT_REFERENCED,
      reason: `nonce UTxO ${decoded.nonce.txHash}#${decoded.nonce.index} is not referenced as a tx input`,
    };
  }

  // ─── Check 6: TTL / expiry ─────────────────────────────────────────
  // Slot semantics: `ttl_bignum` is the FIRST slot at which the tx is
  // INVALID, so the tx must be submitted before that slot. We require
  // `currentSlot < ttlSlot`; equality means the window just closed.
  if (decoded.ttlSlot === null) {
    if (!opts.allowNoTtl) {
      return {
        ok: false,
        code: Codes.EXPIRED_TTL,
        reason: 'transaction has no validity-range upper bound (ttl); set one or call with allowNoTtl=true',
      };
    }
  } else if (opts.currentSlot >= decoded.ttlSlot) {
    return {
      ok: false,
      code: Codes.EXPIRED_TTL,
      reason: `ttl ${decoded.ttlSlot} already passed (current slot ${opts.currentSlot})`,
    };
  }

  // ─── All structural checks pass ────────────────────────────────────
  // `payerAddr` is intentionally omitted here, we don't have the
  // buyer's input addresses without resolving the referenced UTxOs.
  // The facilitator can fill it in via `bridge.getTransactionByHash`
  // on the nonce input, if the caller cares for audit purposes.
  const network = requirements.network as Network;
  return {
    ok: true,
    claim: {
      txHash:      decoded.txHash,
      amountUnits: paid.toString(),
      network,
      unit,
      asset:       requirements.asset,
      payTo:       requirements.payTo,
      resourceUrl: requirements.resource.url,
      nonceRef:    `${decoded.nonce.txHash}#${decoded.nonce.index}`,
    },
  };
}

// ─── Multi-accept selector ───────────────────────────────────────────────

export type PickResult =
  | { ok: true; entry: PaymentRequirementEntry }
  | { ok: false; code: X402Code; reason: string };

/**
 * Select the `accepts[]` entry the buyer actually paid against.
 *
 * Algorithm (first-match wins, accepts[] is the seller's preference order):
 *   1. Filter by network , the buyer's envelope declares one network and
 *      we discard entries that don't match.
 *   2. For each remaining entry, look for an output to `entry.payTo`
 *      containing `entry.asset` with quantity ≥ 1. We don't enforce the
 *      full `amount` here, that's `validatePayment`'s job, we just need
 *      enough signal to know *which* entry the buyer chose.
 *   3. First hit wins. No hit ⇒ `wrong_asset` with a composite reason.
 *
 * For a single-entry `accepts[]`, this returns `accepts[0]` if the
 * network matches, mirroring the pre-multi-accept behaviour exactly.
 */
export function pickRequirement(
  decoded: DecodedPayment,
  body: PaymentRequirementsBody,
): PickResult {
  if (!body.accepts || body.accepts.length === 0) {
    return { ok: false, code: Codes.WRONG_ASSET, reason: 'PaymentRequirementsBody.accepts is empty' };
  }

  const networkOk = body.accepts.filter((e) =>
    networksMatch(decoded.envelope.network, e.network),
  );
  if (networkOk.length === 0) {
    return {
      ok:     false,
      code:   Codes.NETWORK_MISMATCH,
      reason: `payment network '${decoded.envelope.network}' does not match any accepts[].network`,
    };
  }

  // Single-entry shortcut: hand back the lone matching entry, the
  // subsequent validatePayment will run the strict per-entry checks
  // (recipient, amount, asset, ...) just as it did pre-multi-accept.
  if (networkOk.length === 1) {
    return { ok: true, entry: networkOk[0]! };
  }

  // Non-lovelace assets are an unambiguous signal: an output that
  // carries policy X is paying in policy X. Lovelace is ambiguous,
  // EVERY native-asset output to the seller also carries min-ADA in
  // lovelace just to be valid on chain. So we pass over the accepts[]
  // in two passes:
  //   - Pass 1: match any entry whose non-lovelace asset appears in a
  //     payTo output. Strong signal, accept immediately.
  //   - Pass 2: only if no native-asset entry matched, consider
  //     lovelace entries, and only against outputs that are pure ADA
  //     (no native assets). That avoids charging a USDM-paying buyer
  //     against a lovelace entry just because the min-ADA happened to
  //     be in the output.
  for (const entry of networkOk) {
    const parsed = parseAsset(entry.asset);
    if (parsed.isLovelace) continue;
    const hit = decoded.outputs.some(
      (o) => o.address === entry.payTo && o.assets.some((a) => a.unit === parsed.unit),
    );
    if (hit) return { ok: true, entry };
  }
  for (const entry of networkOk) {
    const parsed = parseAsset(entry.asset);
    if (!parsed.isLovelace) continue;
    const hit = decoded.outputs.some(
      (o) => o.address === entry.payTo && o.assets.length === 0 && BigInt(o.lovelace) > 0n,
    );
    if (hit) return { ok: true, entry };
  }

  // No entry matched. Compose a reason listing the (payTo, asset) pairs
  // we expected, so the buyer's client can diagnose which option they
  // tried to pay vs. what the server offered.
  const expected = networkOk
    .map((e) => `${e.asset}@${e.payTo}`)
    .join(' | ');
  return {
    ok:     false,
    code:   Codes.WRONG_ASSET,
    reason: `no accepts[] entry matched the paid (payTo, asset); expected one of: ${expected}`,
  };
}
