/**
 * Post-confirmed payment verifier.
 *
 * Use case: buyer pays out-of-band (CLI, hardware wallet, etc.), then
 * presents a **txHash** to your server. This module fetches the tx
 * from chain via the bridge and confirms it pays the right amount of
 * the right asset to the right address on the right network.
 *
 * Differences from the middleware path (`facilitator/verify.ts`):
 *   - No envelope, no PAYMENT-SIGNATURE header, just a tx hash.
 *   - The tx is presumed already on-chain (the network already accepted
 *     witnesses), so we skip the witness-presence check.
 *   - No on-chain nonce check: replay defense for confirmed-payment
 *     flows is the consumer's job (e.g. "this txHash already redeemed
 *     a subscription" → consumer's DB). v2 still applies for the
 *     middleware path; this helper is for grants that outlive a
 *     single HTTP request.
 *
 * Asset-agnostic: pass either `'lovelace'` or `'<policy>.<nameHex>'`.
 */

import * as bridge from '../bridge';
import { Codes, type X402Code } from '../core/errors';
import { parseAsset } from '../core/asset';
import { parseNetwork, type Network } from '../core/network';

export interface VerifyConfirmedArgs {
  txHash: string;
  /** Required asset amount in raw units (BigInt-safe). */
  requiredAmount: string | number | bigint;
  /** v2 asset string. */
  asset: string;
  /** Bech32 recipient. */
  payTo: string;
  network: Network | string;
}

export type VerifyConfirmedResult =
  | { ok: true; txHash: string; amountUnits: string }
  | { ok: false; code: X402Code; reason: string };

interface TxOutputLite {
  address?: string;
  lovelace?: string | number;
  assets?: Array<{ unit?: string; quantity?: string | number }>;
}
interface TxLite { hash?: string; outputs?: TxOutputLite[] }

function totalPaidToAddress(
  tx: TxLite,
  payTo: string,
  isLovelace: boolean,
  unit: string,
): bigint {
  let total = 0n;
  for (const o of tx.outputs ?? []) {
    if (o.address !== payTo) continue;
    if (isLovelace) {
      total += BigInt(o.lovelace ?? '0');
    } else {
      for (const a of o.assets ?? []) {
        if (String(a.unit ?? '').toLowerCase() === unit) {
          total += BigInt(a.quantity ?? '0');
        }
      }
    }
  }
  return total;
}

export async function verifyConfirmedPayment(
  args: VerifyConfirmedArgs,
): Promise<VerifyConfirmedResult> {
  if (typeof args.txHash !== 'string' || !/^[0-9a-f]{64}$/i.test(args.txHash)) {
    return { ok: false, code: Codes.INVALID_CBOR, reason: 'txHash must be 64-char lowercase hex' };
  }

  // Parse / validate the user-supplied descriptors up front so we
  // return precise diagnostics instead of failing later in the flow.
  let network: Network;
  try { network = parseNetwork(args.network); }
  catch (e) { return { ok: false, code: Codes.INVALID_NETWORK_FORMAT, reason: (e as Error).message }; }
  let parsedAsset;
  try { parsedAsset = parseAsset(args.asset); }
  catch (e) { return { ok: false, code: Codes.INVALID_ASSET_FORMAT, reason: (e as Error).message }; }

  // 1. Fetch from chain.
  let tx: TxLite | null;
  try {
    tx = await bridge.getTransactionByHash(args.txHash) as TxLite | null;
  } catch (err) {
    return {
      ok: false,
      code: Codes.PENDING,
      reason: `bridge.getTransactionByHash failed: ${(err as Error)?.message ?? err}`,
    };
  }
  if (!tx) {
    return {
      ok: false,
      code: Codes.PENDING,
      reason: `tx ${args.txHash} not found on-chain (network=${network})`,
    };
  }

  // 2. Quantity check, summed across all outputs to payTo.
  const paid = totalPaidToAddress(tx, args.payTo, parsedAsset.isLovelace, parsedAsset.unit);
  const required = BigInt(args.requiredAmount);
  if (paid < required) {
    return {
      ok: false,
      code: paid === 0n ? Codes.WRONG_ASSET : Codes.INSUFFICIENT_AMOUNT,
      reason: `paid ${paid} < required ${required} of ${args.asset} to ${args.payTo}`,
    };
  }

  return { ok: true, txHash: args.txHash, amountUnits: paid.toString() };
}
