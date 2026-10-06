/**
 * Asset-transfer methods of the Cardano `exact` scheme.
 *
 * `default` pays `payTo` directly. `script` locks the payment at a script
 * address, optionally with an inline datum from `extra.datum`. The
 * facilitator binds `payTo` to the declared script and checks that the
 * lock carries the declared datum. A resource server that needs more
 * checks uses `verifyTransfer`.
 */

import { dataFromCbor, dataToCbor } from '@harmoniclabs/plutus-data';
import { Codes, type X402Code } from './errors';
import { paymentCredentialOf } from '../helpers/address';
import { applyScriptParameters, plutusScriptHash, type CoreScriptParam } from '../bridge';
import type {
  DecodedOutput,
  DecodedPayment,
  PaymentExtra,
  PaymentRequirements,
  ScriptClaimExtra,
  ScriptTransferExtra,
  TransferScriptParameter,
} from './types';

const SCRIPT_HASH_RE = /^[0-9a-f]{56}$/;
const EVEN_HEX_RE    = /^(?:[0-9a-f]{2})+$/;
const INTEGER_RE     = /^-?\d+$/;

// Applying parameters parses the script; a gate derives the same hash on every request.
const DERIVED_HASHES_MAX = 256;
const derivedHashes = new Map<string, string>();

type Failure = { ok: false; code: X402Code; reason: string };

function failure(code: X402Code, reason: string): Failure {
  return { ok: false, code, reason };
}

/**
 * PlutusData for one parameter, as the Cardano `exact` spec encodes it.
 * `constr`, `list` and `map` have no defined encoding there.
 */
function toCoreParam(name: string, p: TransferScriptParameter): CoreScriptParam {
  switch (p.type) {
    case 'bytes':
      if (typeof p.value !== 'string' || !/^(?:[0-9a-f]{2})*$/.test(p.value)) {
        throw new Error(`parameter '${name}': bytes value must be lowercase hex`);
      }
      return { bytes: p.value };
    case 'string':
      if (typeof p.value !== 'string') throw new Error(`parameter '${name}': string value must be a string`);
      return { bytes: Buffer.from(p.value, 'utf8').toString('hex') };
    case 'bigint':
    case 'integer':
      if (!(typeof p.value === 'bigint'
        || (typeof p.value === 'number' && Number.isSafeInteger(p.value))
        || (typeof p.value === 'string' && INTEGER_RE.test(p.value)))) {
        throw new Error(`parameter '${name}': ${p.type} value must be an integer`);
      }
      return { int: String(p.value) };
    case 'boolean':
      if (typeof p.value !== 'boolean') throw new Error(`parameter '${name}': boolean value must be a boolean`);
      return { constr: p.value ? 1 : 0, fields: [] };
    default:
      throw new Error(`parameter '${name}': type '${String(p.type)}' is not supported`);
  }
}

/**
 * Hash of the script `extra` declares. With `script` it is derived from the
 * code plus `parameters` in key order, and must equal `scriptHash` if both
 * are given.
 */
function declaredScriptHash(x: ScriptTransferExtra): { ok: true; hash: string } | Failure {
  if (!x.script) {
    if (x.scriptHash === undefined) {
      return failure(Codes.SCRIPT_ADDRESS_MISMATCH, "assetTransferMethod 'script' needs extra.scriptHash or extra.script");
    }
    if (!SCRIPT_HASH_RE.test(x.scriptHash.toLowerCase())) {
      return failure(Codes.SCRIPT_ADDRESS_MISMATCH, 'extra.scriptHash must be 56 hex chars');
    }
    return { ok: true, hash: x.scriptHash.toLowerCase() };
  }

  const { type, code } = x.script;
  if (type !== 'plutusV2' && type !== 'plutusV3') {
    return failure(Codes.UNSUPPORTED_METHOD, `extra.script.type '${String(type)}' is not supported (plutusV2, plutusV3)`);
  }
  if (typeof code !== 'string' || !EVEN_HEX_RE.test(code)) {
    return failure(Codes.SCRIPT_ADDRESS_MISMATCH, 'extra.script.code must be lowercase hex');
  }

  let hash: string;
  try {
    const params = Object.entries(x.parameters ?? {}).map(([name, p]) => toCoreParam(name, p));
    const key = `${type}:${code}:${JSON.stringify(params)}`;
    const known = derivedHashes.get(key);
    hash = known ?? plutusScriptHash(params.length > 0 ? applyScriptParameters(code, params) : code, type).toLowerCase();
    if (!known) {
      if (derivedHashes.size >= DERIVED_HASHES_MAX) derivedHashes.clear();
      derivedHashes.set(key, hash);
    }
  } catch (err) {
    return failure(Codes.SCRIPT_ADDRESS_MISMATCH, `extra.script: ${(err as Error)?.message ?? err}`);
  }
  if (x.scriptHash !== undefined && x.scriptHash.toLowerCase() !== hash) {
    return failure(Codes.SCRIPT_ADDRESS_MISMATCH, `extra.script hashes to ${hash}, not extra.scriptHash ${x.scriptHash}`);
  }
  return { ok: true, hash };
}

/** Lowercase CBOR hex of the datum in one canonical encoding, or null if it is not PlutusData. */
function canonicalDatum(hex: string): string | null {
  try {
    return Buffer.from(dataToCbor(dataFromCbor(hex))).toString('hex');
  } catch {
    return null;
  }
}

/**
 * Why `extra` cannot be offered with this `payTo`, or null when it can.
 * Used by `buildRequirements` so a misconfigured seller fails on its own server.
 */
export function transferExtraProblem(extra: PaymentExtra | undefined, payTo: string): string | null {
  const method = extra?.assetTransferMethod ?? 'default';
  if (method === 'default') return null;
  if (method !== 'script') return `assetTransferMethod '${String(method)}' is not supported`;

  const x = extra as ScriptTransferExtra;
  if (x.datum !== undefined && (!EVEN_HEX_RE.test(x.datum) || canonicalDatum(x.datum) === null)) {
    return 'extra.datum must be lowercase CBOR hex of PlutusData';
  }
  const declared = declaredScriptHash(x);
  if (!declared.ok) return declared.reason;

  const cred = paymentCredentialOf(payTo);
  if (cred?.kind !== 'script') return 'payTo must be a script address';
  if (cred.hashHex !== declared.hash) {
    return `payTo credential ${cred.hashHex} is not the declared script ${declared.hash}`;
  }
  return null;
}

export type ScriptTransferResult =
  | { ok: true; claimExtra: ScriptClaimExtra; paidOutput: DecodedOutput }
  | Failure;

/**
 * Script-method checks on top of the six mandatory ones. The datum is
 * compared as PlutusData, not byte for byte, because a client may
 * re-encode it when attaching it.
 */
export function verifyScriptTransfer(
  decoded: DecodedPayment,
  requirement: PaymentRequirements,
  extra: ScriptTransferExtra,
  paying: DecodedOutput[],
): ScriptTransferResult {
  const declared = declaredScriptHash(extra);
  if (!declared.ok) return declared;

  const cred = paymentCredentialOf(requirement.payTo);
  if (cred?.kind !== 'script' || cred.hashHex !== declared.hash) {
    return failure(
      Codes.SCRIPT_ADDRESS_MISMATCH,
      `payTo ${requirement.payTo} is not the address of script ${declared.hash}`,
    );
  }

  // The datum must sit on an output that carries the payment, not on any output to payTo.
  let paidOutput = paying[0]!;
  if (extra.datum !== undefined) {
    const withDatum = paying.filter(o => o.inlineDatumHex !== null);
    if (withDatum.length === 0) {
      return failure(Codes.DATUM_MISSING, 'extra.datum is set but the paying output carries no inline datum');
    }
    const expected = canonicalDatum(extra.datum);
    const match = expected === null ? undefined : withDatum.find(o => canonicalDatum(o.inlineDatumHex!) === expected);
    if (!match) return failure(Codes.DATUM_MISMATCH, 'the paying output does not carry the datum from extra.datum');
    paidOutput = match;
  }

  const locked = decoded.outputs.filter(o => o.address === requirement.payTo);
  return {
    ok: true,
    paidOutput,
    claimExtra: {
      assetTransferMethod: 'script',
      lockRefs: locked.map(o => `${decoded.txHash}#${o.outputIndex}`),
    },
  };
}
