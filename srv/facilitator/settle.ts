/**
 * Submit a signed payment tx to Cardano and confirm settlement.
 *
 * Confirmation policy (v2 spec): accept after first chain sighting.
 * `mempool` status is explicitly discouraged in v2, Cardano's
 * Ouroboros Praos has probabilistic finality, so "in mempool" gives
 * no economic guarantee. We poll for first-chain-sighting via
 * `getTransactionByHash` (resolves to non-null when Blockfrost / Koios
 * has indexed the tx; that's effectively ≥1 confirmation).
 *
 * Confirmation budget: middleware paths use ~60s (covers preprod's
 * worst-case block time of ~20s plus indexer lag). On timeout we
 * return `{ confirmed: false, pending: true }`, the spec contract is
 * that the buyer retries with the same `PAYMENT-SIGNATURE`. Replay
 * defense (on-chain via UTxO nonce) ensures only one retry actually
 * gets served.
 */

import * as bridge from '../bridge';
import { Codes, type X402Code } from '../core/errors';

export interface SettleArgs {
  /** Hex of the signed tx (NOT base64). */
  signedTxCborHex: string;
  /** Locally-computed tx hash from the FixedTransaction; we cross-check submit's response. */
  expectedTxHash: string;
  pollBudgetMs?: number;
  pollIntervalMs?: number;
}

export interface SettleResult {
  confirmed: boolean;
  /** True iff submit succeeded but the tx is not yet indexed. */
  pending?: boolean;
  txHash?: string;
  code?: X402Code;
  reason?: string;
}

/**
 * Patterns surfaced by the submit step that mean "the tx is already
 * known to the network", either in mempool or already mined. In
 * both cases we should NOT treat as failure; we should fall through
 * to polling.
 *
 *   - Blockfrost:    "Transaction is already in the mempool"
 *   - Cardano node:  "ConwayMempoolFailure ... Transaction has probably already been included"
 *   - Ouroboros:     "BadInputsUTxO" / "all inputs are spent"  (already mined)
 *   - Generic:       "transaction already exists"
 *
 * The submit step's failure modes are heterogeneous across backends;
 * regex matching is the only portable detector.
 */
const TX_ALREADY_KNOWN_RE = new RegExp(
  [
    'already (in (the )?(mempool|chain)|exists|been included)',
    'transaction has probably already been included',
    'all inputs are spent',
    'badinputsutxo',
    'valuenotconserved',
    'inputsdepleted',
  ].join('|'),
  'i',
);

export async function settle({
  signedTxCborHex,
  expectedTxHash,
  pollBudgetMs = 60_000,
  pollIntervalMs = 2_500,
}: SettleArgs): Promise<SettleResult> {
  if (!signedTxCborHex) throw new TypeError('settle: signedTxCborHex required');
  if (!expectedTxHash)  throw new TypeError('settle: expectedTxHash required');

  // 1. Submit
  let submittedHash: string | undefined;
  try {
    submittedHash = await bridge.submitTransaction(signedTxCborHex);
  } catch (err) {
    const msg = String((err as { message?: unknown })?.message ?? err ?? '');
    if (TX_ALREADY_KNOWN_RE.test(msg)) {
      // Idempotency: another submit of the same CBOR already happened.
      // Proceed to polling.
      submittedHash = expectedTxHash;
    } else {
      return {
        confirmed: false,
        code:      Codes.SUBMIT_FAILED,
        reason:    msg.slice(0, 200),
      };
    }
  }

  // Cross-check: backend's hash must match our locally-computed one.
  // If it doesn't, something is structurally off, bail loudly.
  if (submittedHash && submittedHash.toLowerCase() !== expectedTxHash.toLowerCase()) {
    return {
      confirmed: false,
      code:      Codes.SUBMIT_FAILED,
      reason:    `submit returned hash ${submittedHash} but tx hashes to ${expectedTxHash}`,
    };
  }

  // 2. Poll for first chain sighting.
  const deadline = Date.now() + pollBudgetMs;
  while (Date.now() < deadline) {
    const tx = await bridge.getTransactionByHash(expectedTxHash);
    if (tx) return { confirmed: true, txHash: expectedTxHash };
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // 3. Timed out.
  return {
    confirmed: false,
    pending:   true,
    txHash:    expectedTxHash,
    code:      Codes.PENDING,
    reason:    'transaction submitted but not yet visible on chain',
  };
}
