/**
 * Cardano-x402-v2 replay-defense check (mandatory check #5).
 *
 * v1 had a CDS entity `X402PaymentNonces` with a UNIQUE on txHash —
 * replay defense was a DB UNIQUE-constraint race. v2 moves replay
 * defense **on-chain**: the buyer references a specific UTxO in the
 * envelope (`payload.nonce = "<txHash>#<index>"`), that UTxO must
 * appear as an input of the payment tx, and once the tx settles the
 * UTxO is permanently consumed. No DB table needed.
 *
 * Check #5 has two parts:
 *   - 5a — the nonce UTxO appears in the tx inputs   (in validate.ts, pure)
 *   - 5b — the nonce UTxO is still unspent on chain  (here, chain-touching)
 *
 * Order in the pipeline: `validate.ts` (which runs 5a) MUST run before
 * `checkNonceUnspent` here. The chain-touching call below is a single
 * `bridge.isUtxoUnspent` round-trip, backed by Blockfrost `consumed_by`
 * / Koios `is_spent` / Ogmios `queryLedgerState/utxo`. Spent and
 * nonexistent UTxOs both surface as `false` — both translate to REPLAY.
 */

import * as bridge from '../bridge';
import { Codes, type X402Code } from '../core/errors';

export interface NonceCheckArgs {
  /** 64-char hex tx-hash of the UTxO acting as replay nonce. */
  txHash: string;
  outputIndex: number;
}

export type NonceResult =
  | { ok: true }
  | { ok: false; code: X402Code; reason: string };

export async function checkNonceUnspent(args: NonceCheckArgs): Promise<NonceResult> {
  const unspent = await bridge.isUtxoUnspent(args.txHash, args.outputIndex);
  if (!unspent) {
    return {
      ok: false,
      code: Codes.REPLAY,
      reason: `nonce UTxO ${args.txHash}#${args.outputIndex} is spent or does not exist on chain`,
    };
  }
  return { ok: true };
}
