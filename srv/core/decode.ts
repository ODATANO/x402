/**
 * Parse the signed transaction of a `PaymentPayload` into the fields the
 * verification rules need. Pure, no chain calls. The transaction hash
 * comes from `@odatano/core` and is byte-preserving.
 */

import { parseTransaction, verifyTxWitnesses, type ParsedTx, type ParsedTxOutput } from '../bridge';
import { base64ToBytes } from './base64';
import { X402Error, Codes } from './errors';
import { parseNonceRef } from './nonce';
import type {
  DecodedAsset,
  DecodedInput,
  DecodedOutput,
  DecodedPayment,
  PaymentPayload,
} from './types';

function toAsset(a: { unit: string; quantity: string }): DecodedAsset {
  // core gives `unit` = policyId (56 hex) + assetNameHex
  const unit = a.unit.toLowerCase();
  return { unit, policyId: unit.slice(0, 56), assetNameHex: unit.slice(56), quantity: a.quantity };
}

function extractOutputs(outputs: ParsedTxOutput[]): DecodedOutput[] {
  return outputs.map((o, i) => ({
    outputIndex:    i,
    address:        o.address,
    lovelace:       o.lovelace,
    assets:         o.assets.map(toAsset),
    inlineDatumHex: o.inlineDatumHex ?? null,
    ...(typeof o.cborSize === 'number' ? { cborSize: o.cborSize } : {}),
  }));
}

function extractInputs(inputs: ParsedTx['inputs']): DecodedInput[] {
  return inputs.map(inp => ({ txHash: inp.txHash.toLowerCase(), outputIndex: inp.outputIndex }));
}

/** core reports slots as decimal strings; they fit a JS number. */
function toSlot(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Names of body parts that move value outside inputs and outputs. */
function extraBodyContent(parsed: ParsedTx): string[] {
  const found: string[] = [];
  if (parsed.withdrawals?.length) found.push('withdrawals');
  if (parsed.certificates?.length) found.push('certificates');
  if (parsed.votingProcedures) found.push('voting procedures');
  if (parsed.proposalProcedures) found.push('proposal procedures');
  if (parsed.treasuryDonation != null && BigInt(parsed.treasuryDonation) > 0n) found.push('treasury donation');
  return found;
}

/** Throws `X402Error` (`transaction_decode_failed`, `nonce_invalid`). */
export function decodePayment(payload: PaymentPayload): DecodedPayment {
  const nonce = parseNonceRef(payload.payload.nonce);
  if (!nonce) {
    throw new X402Error(Codes.INVALID_NONCE_FORMAT, `nonce '${String(payload.payload.nonce)}' must be '<txHash>#<outputIndex>'`);
  }
  const txBytes = base64ToBytes(payload.payload.transaction);
  if (!txBytes || txBytes.length === 0) {
    throw new X402Error(Codes.INVALID_CBOR, 'payload.transaction is not base64');
  }
  const txCborHex = Buffer.from(txBytes).toString('hex');
  const parsed = parseTransaction(txCborHex);
  const witnesses = verifyTxWitnesses(txCborHex);

  return {
    payload,
    txCborHex,
    txHash:            parsed.txHash.toLowerCase(),
    outputs:           extractOutputs(parsed.outputs),
    inputs:            extractInputs(parsed.inputs),
    mint:              (parsed.mint ?? []).map(toAsset),
    fee:               parsed.fee,
    vkeyWitnessCount:  parsed.witnesses.vkeyCount,
    networkId:         parsed.networkId ?? null,
    isValid:           parsed.isValid === true,
    extraBodyContent:  extraBodyContent(parsed),
    signerKeyHashes:   witnesses.signerKeyHashes.map(h => h.toLowerCase()),
    witnessErrors:     witnesses.valid ? [] : witnesses.errors,
    ttlSlot:           toSlot(parsed.validityEnd),
    validityStartSlot: toSlot(parsed.validityStart),
    nonce,
  };
}
