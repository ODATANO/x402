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

import { parseTransaction, type ParsedTx, type ParsedTxOutput } from '../bridge';
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

function extractOutputs(outputs: ParsedTxOutput[]): DecodedOutput[] {
  return outputs.map((o, i) => {
    const assets: DecodedAsset[] = o.assets.map(a => {
      // core gives `unit` = policyId(56 hex) + assetNameHex; split it back
      // into the (policyId, assetNameHex) pair x402's validate.ts expects.
      const unit = a.unit.toLowerCase();
      return {
        unit,
        policyId:     unit.slice(0, 56),
        assetNameHex: unit.slice(56),
        quantity:     a.quantity,
      };
    });
    return { outputIndex: i, address: o.address, lovelace: o.lovelace, assets };
  });
}

function extractInputs(inputs: ParsedTx['inputs']): DecodedInput[] {
  return inputs.map(inp => ({
    txHash:      inp.txHash.toLowerCase(),
    outputIndex: inp.outputIndex,
  }));
}

/**
 * Convert core's decimal-string slot bounds to numbers. Both bounds can
 * be null, in which case the downstream TTL check is skipped (per v2
 * spec: only validate TTL if the buyer set one). Slots fit comfortably
 * in a JS number (current preprod ~85M, max safe int 9e15).
 */
function extractValidityRange(parsed: ParsedTx): {
  ttlSlot: number | null;
  validityStartSlot: number | null;
} {
  const toSlot = (s: string | null): number | null => {
    if (s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  return {
    ttlSlot:           toSlot(parsed.validityEnd),
    validityStartSlot: toSlot(parsed.validityStart),
  };
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

  // 3. Tx CBOR → structured fields via @odatano/core's pure Buildooor
  //    parser. `parseTransaction` throws X402Error(INVALID_CBOR) on
  //    malformed input, and its `txHash` (= body.hash) is byte-preserving,
  //    the property the old CSL `FixedTransaction` path provided.
  const txBuf = decodeBase64ToBuffer(payload.transaction, Codes.INVALID_CBOR);
  const txCborHex = txBuf.toString('hex');
  const parsed = parseTransaction(txCborHex);

  // 4. Diagnostics
  const txHash = parsed.txHash.toLowerCase();
  const vkeyWitnessCount = parsed.witnesses.vkeyCount;

  const validity = extractValidityRange(parsed);
  const nonce = parseNonceRef(payload.nonce);

  const envelope: PaymentEnvelope = {
    x402Version: SUPPORTED_VERSION,
    scheme:      SUPPORTED_SCHEME,
    network:     raw.network!,
    payload:     { transaction: payload.transaction, nonce: payload.nonce },
  };

  return {
    envelope,
    txCborHex,
    txHash,
    outputs:           extractOutputs(parsed.outputs),
    inputs:            extractInputs(parsed.inputs),
    vkeyWitnessCount,
    ttlSlot:           validity.ttlSlot,
    validityStartSlot: validity.validityStartSlot,
    nonce,
  };
}
