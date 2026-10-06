/**
 * Structural verification rules of Cardano `exact` that need no chain
 * calls. Pure.
 *
 *   1. Network: body network id and every Shelley output address match the requirement
 *   2. Recipient: at least one output to `payTo`
 *   3. Amount: one output to `payTo` carries at least `amount` of `asset`
 *   4. Asset: policy and name match exactly
 *   5. Nonce: the nonce UTxO is a tx input (unspent check: facilitator/chain.ts)
 *   6. Phase-1 parts without chain data: valid vkey signatures, nothing the
 *      inputs and outputs do not show (mint, withdrawals, certificates,
 *      governance, donation), validity start reached
 *   7. TTL: present, not passed, not beyond `maxTtlSlot`
 *
 * `script` transfers additionally bind `payTo` to the declared script
 * (`transfer.ts`). Other transfer methods are rejected. Value
 * conservation, the fee floor, min-UTxO and the unspent checks need chain
 * data and run in the facilitator.
 */

import { Codes, type X402Code } from './errors';
import { addressNetworkId, normalizeNetwork } from './network';
import { parseAsset } from './asset';
import { verifyScriptTransfer } from './transfer';
import { isScriptExtra, isSupportedTransferMethod, transferMethodOf } from './transfer-method';
import { addressNetworkIdOf } from '../helpers/address';
import type {
  DecodedOutput,
  DecodedPayment,
  PaymentClaim,
  PaymentRequirements,
  ScriptClaimExtra,
} from './types';

/** What the matched output proves about the payment. */
export interface PaymentMatch {
  /** Amount of `asset` the matched `payTo` output carries, atomic units. */
  amountUnits: string;
  /** `policyId+nameHex`; empty for lovelace. */
  unit: string;
  extra?: ScriptClaimExtra;
}

export type ValidationResult =
  | { ok: true; match: PaymentMatch }
  | { ok: false; code: X402Code; reason: string };

export interface ValidateOptions {
  currentSlot: number;
  /** Latest TTL slot allowed (now + `maxTimeoutSeconds`); unset skips the upper bound. */
  maxTtlSlot?: number;
  /**
   * The ledger already accepted this transaction (pending-settlement
   * retry): the TTL and validity start no longer gate it.
   */
  alreadyAccepted?: boolean;
}

function quantityOf(output: DecodedOutput, isLovelace: boolean, unit: string): bigint {
  if (isLovelace) return BigInt(output.lovelace);
  const a = output.assets.find(x => x.unit === unit);
  return a ? BigInt(a.quantity) : 0n;
}

function fail(code: X402Code, reason: string): ValidationResult {
  return { ok: false, code, reason };
}

export function validatePayment(
  decoded: DecodedPayment,
  requirements: PaymentRequirements,
  opts: ValidateOptions,
): ValidationResult {
  if (!decoded.vkeyWitnessCount || decoded.vkeyWitnessCount < 1) {
    return fail(Codes.UNSIGNED_TRANSACTION, 'transaction has no vkey witnesses');
  }
  if (!decoded.isValid) {
    return fail(Codes.PHASE2_INVALID, 'transaction is marked invalid: its outputs would never exist');
  }
  if (decoded.witnessErrors.length > 0) {
    return fail(Codes.INVALID_SIGNATURE, decoded.witnessErrors.join('; '));
  }

  const method = transferMethodOf(requirements);
  if (!isSupportedTransferMethod(method)) {
    return fail(Codes.UNSUPPORTED_METHOD, `assetTransferMethod '${method}' is not supported`);
  }

  // ─── Rule 1: network ───────────────────────────────────────────────
  const network = normalizeNetwork(requirements.network);
  if (!network) return fail(Codes.INVALID_NETWORK_FORMAT, `network '${String(requirements.network)}' is not a Cardano network`);
  const networkId = addressNetworkId(network);
  if (decoded.networkId !== null && decoded.networkId !== networkId) {
    return fail(Codes.NETWORK_MISMATCH, `transaction body is for network id ${decoded.networkId}, not ${requirements.network}`);
  }
  const foreign = decoded.outputs.find(o => {
    const id = addressNetworkIdOf(o.address);
    return id !== null && id !== networkId;
  });
  if (foreign) {
    return fail(Codes.NETWORK_MISMATCH, `output ${foreign.outputIndex} is not on ${requirements.network}`);
  }

  // ─── Rules 2-4 and script binding ──────────────────────────────────
  const matched = matchOutput(decoded, requirements);
  if (!matched.ok) return matched;

  // ─── Rule 5: nonce is an input ─────────────────────────────────────
  const nonceInInputs = decoded.inputs.some(
    i => i.txHash === decoded.nonce.txHash && i.outputIndex === decoded.nonce.index,
  );
  if (!nonceInInputs) {
    return fail(
      Codes.NONCE_NOT_REFERENCED,
      `nonce UTxO ${decoded.nonce.txHash}#${decoded.nonce.index} is not a tx input`,
    );
  }

  // ─── Rule 6 (chain-free part): nothing the inputs and outputs do not show ──
  if (decoded.mint.length > 0) {
    return fail(Codes.PHASE1_INVALID, 'transaction mints or burns assets');
  }
  if (decoded.extraBodyContent.length > 0) {
    return fail(Codes.PHASE1_INVALID, `transaction carries ${decoded.extraBodyContent.join(', ')}`);
  }

  // ─── Rule 7: validity window ───────────────────────────────────────
  // `ttlSlot` is the first slot at which the tx is invalid.
  if (decoded.ttlSlot === null) {
    return fail(Codes.EXPIRED_TTL, 'transaction has no validity-range upper bound (ttl)');
  }
  if (!opts.alreadyAccepted) {
    if (opts.currentSlot >= decoded.ttlSlot) {
      return fail(Codes.EXPIRED_TTL, `ttl ${decoded.ttlSlot} already passed (current slot ${opts.currentSlot})`);
    }
    if (decoded.validityStartSlot !== null && decoded.validityStartSlot > opts.currentSlot) {
      return fail(
        Codes.NOT_YET_VALID,
        `validity starts at slot ${decoded.validityStartSlot} (current slot ${opts.currentSlot})`,
      );
    }
    if (opts.maxTtlSlot !== undefined && decoded.ttlSlot > opts.maxTtlSlot) {
      return fail(
        Codes.TTL_TOO_FAR,
        `ttl ${decoded.ttlSlot} is beyond now + maxTimeoutSeconds (slot ${opts.maxTtlSlot})`,
      );
    }
  }

  return matched;
}

/**
 * Rules 2-4 plus the script binding: the `payTo` output that pays the
 * requirement. Pure; the middleware uses it to build the claim.
 */
export function matchOutput(decoded: DecodedPayment, requirements: PaymentRequirements): ValidationResult {
  const parsed = parseAsset(requirements.asset);
  const required = BigInt(requirements.amount);
  const toPayTo = decoded.outputs.filter(o => o.address === requirements.payTo);
  if (toPayTo.length === 0) {
    return fail(Codes.WRONG_RECIPIENT, `no output to payTo ${requirements.payTo}`);
  }
  const quantity = (o: DecodedOutput) => quantityOf(o, parsed.isLovelace, parsed.unit);
  const best = toPayTo.map(quantity).reduce((a, b) => (b > a ? b : a));
  if (best === 0n) {
    return fail(Codes.WRONG_ASSET, `no output to payTo carries asset ${requirements.asset}`);
  }
  if (best < required) {
    return fail(
      Codes.INSUFFICIENT_AMOUNT,
      `largest output to payTo carries ${best.toString()} < required ${required.toString()} of ${requirements.asset}`,
    );
  }
  // Outputs to payTo that cover the amount alone, largest first.
  const paying = toPayTo.filter(o => quantity(o) >= required).sort((a, b) => (quantity(b) > quantity(a) ? 1 : -1));

  let paid = paying[0]!;
  let scriptExtra: ScriptClaimExtra | undefined;
  if (isScriptExtra(requirements.extra)) {
    const r = verifyScriptTransfer(decoded, requirements, requirements.extra, paying);
    if (!r.ok) return r;
    scriptExtra = r.claimExtra;
    paid = r.paidOutput;
  }
  return {
    ok: true,
    match: {
      amountUnits: quantity(paid).toString(),
      unit:        parsed.unit,
      ...(scriptExtra ? { extra: scriptExtra } : {}),
    },
  };
}

/** The `PaymentClaim` of a verified payment. */
export function buildClaim(
  decoded: DecodedPayment,
  requirements: PaymentRequirements,
  match: PaymentMatch,
  resourceUrl: string,
  payerAddr?: string,
): PaymentClaim {
  return {
    txHash:      decoded.txHash,
    amountUnits: match.amountUnits,
    network:     requirements.network,
    unit:        match.unit,
    asset:       requirements.asset,
    payTo:       requirements.payTo,
    resourceUrl,
    nonceRef:    `${decoded.nonce.txHash}#${decoded.nonce.index}`,
    ...(payerAddr ? { payerAddr } : {}),
    ...(match.extra ? { extra: match.extra } : {}),
  };
}
