/**
 * Verification rules of Cardano `exact` that need chain data:
 *
 *   5. every input, the nonce included, exists and is unspent
 *   6. every key-locked input is signed by its key
 *   6. value conservation (inputs = outputs + fee, per asset) and the fee
 *      floor `minFeeB + minFeeA * |tx|` from live protocol parameters
 *   8. the `payTo` output holds the min-UTxO for its size, when the size is known
 *
 * Also resolves the payer: the address of the nonce UTxO, proven by the
 * signature that spends it.
 */

import * as bridge from '../bridge';
import { paymentCredentialOf } from '../helpers/address';
import { Codes, type X402Code } from '../core/errors';
import type { DecodedPayment, PaymentRequirements } from '../core/types';

export type ChainCheckResult =
  | { ok: true; payerAddr?: string }
  | { ok: false; code: X402Code; reason: string };

export interface ChainCheckOptions {
  /**
   * The ledger already accepted this exact transaction (pending retry):
   * its inputs are spent by it, so the unspent check no longer applies.
   */
  alreadyAccepted?: boolean;
}

type Value = Map<string, bigint>;

function add(v: Value, unit: string, q: bigint): void {
  v.set(unit, (v.get(unit) ?? 0n) + q);
}

function fail(code: X402Code, reason: string): ChainCheckResult {
  return { ok: false, code, reason };
}

export async function checkOnChain(
  decoded: DecodedPayment,
  requirements: PaymentRequirements,
  opts: ChainCheckOptions = {},
): Promise<ChainCheckResult> {
  const nonceKey = `${decoded.nonce.txHash}#${decoded.nonce.index}`;
  const txCache = new Map<string, Promise<bridge.ChainTx | null>>();
  const txOf = (hash: string) => {
    let p = txCache.get(hash);
    if (!p) { p = bridge.getTransactionByHash(hash); txCache.set(hash, p); }
    return p;
  };

  // ─── Rule 5: inputs exist and are unspent ──────────────────────────
  const inputs: Value = new Map();
  let payerAddr: string | undefined;
  const looked = await Promise.all(decoded.inputs.map(async (input) => {
    const tx = await txOf(input.txHash);
    const out = tx ? bridge.createdOutputs(tx).find(o => o.outputIndex === input.outputIndex) : undefined;
    const unspent = out !== undefined
      && (opts.alreadyAccepted || await bridge.isUtxoUnspent(input.txHash, input.outputIndex));
    return { input, out, unspent };
  }));
  for (const { input, out, unspent } of looked) {
    const key = `${input.txHash}#${input.outputIndex}`;
    const isNonce = key === nonceKey;
    if (!out) {
      return isNonce
        ? fail(Codes.REPLAY, `nonce UTxO ${key} does not exist on chain`)
        : fail(Codes.INPUT_NOT_AVAILABLE, `input ${key} does not exist on chain`);
    }
    if (!unspent) {
      return isNonce
        ? fail(Codes.REPLAY, `nonce UTxO ${key} is already spent`)
        : fail(Codes.INPUT_NOT_AVAILABLE, `input ${key} is already spent`);
    }
    const cred = paymentCredentialOf(out.address);
    if (cred?.kind === 'key' && !decoded.signerKeyHashes.includes(cred.hashHex)) {
      return fail(Codes.INVALID_SIGNATURE, `input ${key} is not signed by the key of ${out.address}`);
    }
    if (isNonce) payerAddr = out.address;
    for (const a of out.amount) add(inputs, a.unit === 'lovelace' ? '' : a.unit.toLowerCase(), BigInt(a.quantity));
  }

  // ─── Rule 6: value conservation ────────────────────────────────────
  const outputs: Value = new Map();
  for (const o of decoded.outputs) {
    add(outputs, '', BigInt(o.lovelace));
    for (const a of o.assets) add(outputs, a.unit, BigInt(a.quantity));
  }
  add(outputs, '', BigInt(decoded.fee));
  for (const unit of new Set([...inputs.keys(), ...outputs.keys()])) {
    const i = inputs.get(unit) ?? 0n;
    const o = outputs.get(unit) ?? 0n;
    if (i !== o) {
      return fail(
        Codes.VALUE_NOT_CONSERVED,
        `${unit || 'lovelace'}: inputs ${i.toString()} != outputs + fee ${o.toString()}`,
      );
    }
  }

  // ─── Rule 6: fee floor ─────────────────────────────────────────────
  const params = await bridge.getFeeParameters();
  const txBytes = BigInt(decoded.txCborHex.length / 2);
  const minFee = params.minFeeB + params.minFeeA * txBytes;
  if (BigInt(decoded.fee) < minFee) {
    return fail(Codes.FEE_BELOW_MINIMUM, `fee ${decoded.fee} < minimum ${minFee.toString()}`);
  }

  // ─── Rule 8: min-UTxO of the payTo output ──────────────────────────
  if (params.coinsPerUtxoByte !== null) {
    for (const o of decoded.outputs) {
      if (o.address !== requirements.payTo || o.cborSize === undefined) continue;
      const minUtxo = (160n + BigInt(o.cborSize)) * params.coinsPerUtxoByte;
      if (BigInt(o.lovelace) < minUtxo) {
        return fail(
          Codes.MIN_UTXO_INSUFFICIENT,
          `output ${o.outputIndex} holds ${o.lovelace} lovelace < min-UTxO ${minUtxo.toString()}`,
        );
      }
    }
  }

  return { ok: true, ...(payerAddr ? { payerAddr } : {}) };
}
