/**
 * Server-side unsigned payment-tx builder for browser-buyer flows.
 *
 * The browser knows the buyer's bech32 (via CIP-30) but not the signing
 * keys, and shipping coin-selection + protocol-params logic to the
 * browser would mean megabytes of WASM. So we build the unsigned tx
 * server-side, return the CBOR for the wallet to sign, and let the
 * browser submit the signed CBOR as `payload.transaction` in the
 * PAYMENT-SIGNATURE envelope.
 *
 * The build itself (UTxO fetch, coin selection, change, min-ADA, fee) is
 * delegated wholesale to `@odatano/core`'s Buildooor builder via
 * `bridge.buildUnsignedTransfer`, x402 owns no tx-construction library.
 * We add only the two x402-specific pieces core doesn't:
 *   - the `requiredSignerHex` (buyer's payment-cred VKey hash), parsed
 *     from the bech32 address (see `./address`);
 *   - the v2 `nonceRef`, read back from the built tx's first input so it
 *     is guaranteed to reference a UTxO the tx actually spends.
 *
 * **x402-spec deviation:** strict v2 has the buyer construct the tx
 * end-to-end. This is the "self-facilitator" pattern: the server builds,
 * the buyer signs, the server still validates the signed tx against
 * requirements before settling. Same security model (the buyer's
 * signature still authorises the spend), easier browser ergonomics.
 */

import * as bridge from '../bridge';
import type { PaymentRequirementEntry } from '../core/types';
import { parseAsset } from '../core/asset';
import { parsePaymentAddress } from './address';

/** ADA (lovelace) attached to a native-asset output to satisfy min-ADA. */
const TOKEN_OUTPUT_LOVELACE = 2_000_000n;

/** Cardano networks run 1-second slots, so TTL slots ≈ TTL seconds. */
const SLOT_MS = 1000;

export interface BuildUnsignedTxArgs {
  /** Buyer's bech32 address (must be Base or Enterprise with VKey-hash payment cred). */
  buyerBech32: string;
  /** A single accepts[] entry, call `flatRequirements(body)` to extract. */
  requirements: PaymentRequirementEntry;
  /**
   * Optional TTL in slots from "now" (= current chain tip).
   * Default 1800 (≈30 min on Cardano's 1s-slot networks).
   */
  ttlSlotsFromNow?: number;
}

export interface UnsignedTxResult {
  /** CBOR hex of the unsigned tx (empty witness set). Ready for CIP-30 signTx. */
  unsignedTxCborHex: string;
  /** Hex tx hash, what the buyer's wallet will display. */
  txHashHex:         string;
  /** Buyer's payment-cred VKey hash, wallet must sign for this. */
  requiredSignerHex: string;
  /** v2 nonce reference `<txHash>#<index>`, the tx's first spent input. */
  nonceRef:          string;
  /** Echo of the inputs the builder selected so the buyer's UI can show "spends these UTxOs". */
  inputs: Array<{ txHash: string; outputIndex: number; lovelace: string }>;
  /** TTL slot used for the validity-range upper bound (as set by the builder). */
  ttlSlot:           number | null;
}

export async function buildUnsignedPaymentTx(
  args: BuildUnsignedTxArgs,
): Promise<UnsignedTxResult> {
  const { buyerBech32, requirements } = args;

  // 1. Validate the buyer address shape and derive the required signer.
  //    Throws for bad bech32 / script-cred / non-payment addresses.
  const { paymentKeyHashHex } = parsePaymentAddress(buyerBech32);

  // 2. Translate the v2 requirement into a core transfer request.
  const parsedAsset = parseAsset(requirements.asset);
  const required = BigInt(requirements.amount);
  const validityEndMs = Date.now() + (args.ttlSlotsFromNow ?? 1800) * SLOT_MS;

  const req: bridge.CoreTransferReq = parsedAsset.isLovelace
    ? {
        senderAddress:    buyerBech32,
        recipientAddress: requirements.payTo,
        changeAddress:    buyerBech32,
        lovelaceAmount:   required.toString(),
        validityEndMs,
      }
    : {
        senderAddress:    buyerBech32,
        recipientAddress: requirements.payTo,
        changeAddress:    buyerBech32,
        // Native-asset output rides a fixed min-ADA; change reconciles the rest.
        lovelaceAmount:   TOKEN_OUTPUT_LOVELACE.toString(),
        assets:           [{ unit: parsedAsset.unit, quantity: required.toString() }],
        validityEndMs,
      };

  // 3. Delegate the build (UTxO fetch + coin selection + change + fee).
  const result = await bridge.buildUnsignedTransfer(req);

  // 4. Read the built tx back to recover the v2 nonce (first spent input,
  //    guaranteed present) and the TTL slot the builder actually set.
  const parsed = bridge.parseTransaction(result.unsignedTxCbor);
  const nonceInput = parsed.inputs[0];
  if (!nonceInput) {
    throw new Error('buildUnsignedPaymentTx: builder produced a tx with no inputs');
  }
  const nonceRef = `${nonceInput.txHash}#${nonceInput.outputIndex}`;
  const ttlSlot = parsed.validityEnd != null ? Number(parsed.validityEnd) : null;

  return {
    unsignedTxCborHex: result.unsignedTxCbor,
    txHashHex:         result.txBodyHash.toLowerCase(),
    requiredSignerHex: paymentKeyHashHex,
    nonceRef,
    inputs: result.inputs.map(i => ({
      txHash:      i.txHash,
      outputIndex: i.index,
      lovelace:    i.lovelace,
    })),
    ttlSlot,
  };
}
