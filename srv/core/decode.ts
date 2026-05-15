/**
 * Decode the `PAYMENT-SIGNATURE` header (Cardano-x402-v2 wire format).
 *
 * Wire format:
 *   PAYMENT-SIGNATURE: base64(JSON.stringify({
 *     x402Version: 2,
 *     scheme: 'exact',
 *     network: 'cardano:preprod' | 'cardano:mainnet' | 'cardano:preview',
 *     payload: {
 *       transaction: '<base64 CBOR of signed tx>',
 *       nonce:       '<txHash>#<outputIndex>'
 *     }
 *   }))
 *
 * The decoder is **pure**, no chain calls, no DB. It produces a
 * `DecodedPayment` that downstream `validate.ts` checks against
 * `PaymentRequirementEntry` (the 6 mandatory checks).
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { X402Error, Codes, type X402Code } from './errors';
import type {
  DecodedPayment,
  DecodedOutput,
  DecodedInput,
  DecodedAsset,
  PaymentEnvelope,
} from './types';

const SUPPORTED_VERSION = 2;
const SUPPORTED_SCHEME  = 'exact';
const NONCE_RE          = /^([0-9a-f]{64})#(\d+)$/i;

function decodeBase64ToBuffer(s: string, errCode: X402Code): Buffer {
  // Node's Buffer.from is lenient (silently drops bad chars). Re-encode
  // and compare modulo padding to catch malformed input early, otherwise
  // garbage in `transaction` would only fail at CBOR parse time with a
  // confusing error.
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== String(s).replace(/=+$/, '')) {
    throw new X402Error(errCode, 'malformed base64 payload');
  }
  return buf;
}

function extractOutputs(txBody: CSL.TransactionBody): DecodedOutput[] {
  const out = txBody.outputs();
  const result: DecodedOutput[] = [];
  for (let i = 0; i < out.len(); i++) {
    const o = out.get(i);
    const addr = o.address().to_bech32();
    const value = o.amount();
    const lovelace = value.coin().to_str();

    const assets: DecodedAsset[] = [];
    const ma = value.multiasset();
    if (ma) {
      const policies = ma.keys();
      for (let p = 0; p < policies.len(); p++) {
        const policy = policies.get(p);
        const policyHex = Buffer.from(policy.to_bytes()).toString('hex').toLowerCase();
        const assetMap = ma.get(policy);
        if (!assetMap) continue;
        const names = assetMap.keys();
        for (let n = 0; n < names.len(); n++) {
          const name = names.get(n);
          const nameHex = Buffer.from(name.name()).toString('hex').toLowerCase();
          const qty = assetMap.get(name);
          if (!qty) continue;
          assets.push({
            unit:         (policyHex + nameHex),
            policyId:     policyHex,
            assetNameHex: nameHex,
            quantity:     qty.to_str(),
          });
        }
      }
    }
    result.push({ outputIndex: i, address: addr, lovelace, assets });
  }
  return result;
}

function extractInputs(txBody: CSL.TransactionBody): DecodedInput[] {
  const ins = txBody.inputs();
  const result: DecodedInput[] = [];
  for (let i = 0; i < ins.len(); i++) {
    const inp = ins.get(i);
    result.push({
      txHash:      Buffer.from(inp.transaction_id().to_bytes()).toString('hex').toLowerCase(),
      outputIndex: inp.index(),
    });
  }
  return result;
}

/**
 * Pull validity range bounds. CSL exposes `ttl()` (upper) since Shelley
 * and `validity_start_interval_bignum()` (lower) since Allegra. Both can
 * be absent, in which case we return null and the TTL check is skipped
 * (per v2 spec: only validate TTL if buyer set one).
 */
function extractValidityRange(txBody: CSL.TransactionBody): {
  ttlSlot: number | null;
  validityStartSlot: number | null;
} {
  let ttlSlot: number | null = null;
  let validityStartSlot: number | null = null;

  try {
    const ttl = txBody.ttl_bignum();
    if (ttl) {
      // BigNum → string → number; slots fit comfortably in JS number
      // (current preprod ~85M, max safe int 9e15).
      ttlSlot = Number(ttl.to_str());
      if (!Number.isFinite(ttlSlot)) ttlSlot = null;
    }
  } catch { ttlSlot = null; }

  try {
    const start = txBody.validity_start_interval_bignum();
    if (start) {
      validityStartSlot = Number(start.to_str());
      if (!Number.isFinite(validityStartSlot)) validityStartSlot = null;
    }
  } catch { validityStartSlot = null; }

  return { ttlSlot, validityStartSlot };
}

interface RawEnvelope {
  x402Version?: number;
  scheme?: string;
  network?: string;
  payload?: { transaction?: string; nonce?: string };
}

function parseNonceRef(nonce: string): { txHash: string; index: number } {
  const m = NONCE_RE.exec(nonce);
  if (!m) {
    throw new X402Error(
      Codes.INVALID_NONCE_FORMAT,
      `nonce '${nonce}' must be '<txHash>#<outputIndex>' (64-hex#int)`,
    );
  }
  const idx = Number(m[2]);
  if (!Number.isFinite(idx) || idx < 0 || idx > 65535) {
    throw new X402Error(
      Codes.INVALID_NONCE_FORMAT,
      `nonce output index ${m[2]} out of range`,
    );
  }
  return { txHash: m[1]!.toLowerCase(), index: idx };
}

/**
 * Decode a `PAYMENT-SIGNATURE` header value end-to-end. Throws X402Error
 * with a precise `code` on any malformed input, the caller catches and
 * surfaces the code in the 402 response body.
 */
export function decode(paymentHeader: string | undefined | null): DecodedPayment {
  if (!paymentHeader || typeof paymentHeader !== 'string') {
    throw new X402Error(Codes.MISSING_HEADER);
  }

  // 1. base64 → JSON
  const outerBuf = decodeBase64ToBuffer(paymentHeader, Codes.INVALID_BASE64);
  let raw: RawEnvelope;
  try { raw = JSON.parse(outerBuf.toString('utf8')) as RawEnvelope; }
  catch { throw new X402Error(Codes.INVALID_JSON, 'PAYMENT-SIGNATURE body is not valid JSON'); }

  // 2. Field shape
  for (const f of ['x402Version', 'scheme', 'network', 'payload'] as const) {
    if (!(f in raw)) throw new X402Error(Codes.MISSING_FIELD, `missing field: ${f}`);
  }
  if (raw.x402Version !== SUPPORTED_VERSION) {
    throw new X402Error(
      Codes.UNSUPPORTED_VERSION,
      `x402Version ${raw.x402Version} not supported (only ${SUPPORTED_VERSION})`,
    );
  }
  if (raw.scheme !== SUPPORTED_SCHEME) {
    throw new X402Error(
      Codes.UNSUPPORTED_SCHEME,
      `scheme '${raw.scheme}' not supported (only '${SUPPORTED_SCHEME}')`,
    );
  }
  const payload = raw.payload;
  if (!payload || typeof payload.transaction !== 'string') {
    throw new X402Error(Codes.MISSING_FIELD, 'payload.transaction is required');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce.length === 0) {
    throw new X402Error(Codes.MISSING_FIELD, 'payload.nonce is required (v2 UTxO-ref)');
  }

  // 3. Tx CBOR → CSL Transaction (parses both `transaction` and `fixed`
  //    representation; we need both, Transaction for body access,
  //    FixedTransaction for byte-stable hash).
  const txBuf = decodeBase64ToBuffer(payload.transaction, Codes.INVALID_CBOR);
  let tx: CSL.Transaction;
  try { tx = CSL.Transaction.from_bytes(txBuf); }
  catch { throw new X402Error(Codes.INVALID_CBOR, 'transaction CBOR did not decode'); }

  // 4. Diagnostics
  const txBody = tx.body();
  const wits = tx.witness_set();
  const vkeys = wits.vkeys();
  const vkeyWitnessCount = vkeys ? vkeys.len() : 0;

  const txHashBytes = CSL.FixedTransaction
    .from_bytes(txBuf)
    .transaction_hash()
    .to_bytes();
  const txHash = Buffer.from(txHashBytes).toString('hex').toLowerCase();

  const validity = extractValidityRange(txBody);
  const nonce = parseNonceRef(payload.nonce);

  const envelope: PaymentEnvelope = {
    x402Version: SUPPORTED_VERSION,
    scheme:      SUPPORTED_SCHEME,
    network:     raw.network!,
    payload:     { transaction: payload.transaction, nonce: payload.nonce },
  };

  return {
    envelope,
    txCborHex:         Buffer.from(txBuf).toString('hex'),
    txHash,
    outputs:           extractOutputs(txBody),
    inputs:            extractInputs(txBody),
    vkeyWitnessCount,
    ttlSlot:           validity.ttlSlot,
    validityStartSlot: validity.validityStartSlot,
    nonce,
  };
}
