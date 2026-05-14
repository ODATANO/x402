/**
 * Build deterministic signed Cardano transactions for tests.
 *
 * We construct TransactionBody directly (no TransactionBuilder, no coin
 * selection, no protocol-params fetch) so the fixtures are reproducible
 * across CI environments and don't require a chain backend. Tests that
 * need a specific shape (multiple outputs, lovelace-only, missing TTL,
 * etc.) compose these helpers.
 *
 * `signTestTx` uses `CSL.FixedTransaction` for the body hash — matches
 * how `srv/core/decode.ts` computes it, so hashes round-trip without
 * surprises.
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';

export interface TestInput {
  txHash: string;       // 64 hex
  outputIndex: number;
}

export interface TestAsset {
  policyId: string;     // 56 hex
  nameHex: string;      // 0..64 hex
  qty: string;          // raw units
}

export interface TestOutput {
  address: string;      // bech32
  lovelace: string;     // raw units
  assets?: TestAsset[];
}

export interface BuildTxArgs {
  inputs: TestInput[];
  outputs: TestOutput[];
  fee?: string;         // default '200000'
  ttlSlot?: number;     // optional validity-range upper bound
  validityStartSlot?: number;
}

function buildMultiAsset(assets: TestAsset[]): CSL.MultiAsset {
  const ma = CSL.MultiAsset.new();
  const byPolicy = new Map<string, CSL.Assets>();
  for (const a of assets) {
    const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(a.policyId, 'hex'));
    const key = a.policyId.toLowerCase();
    let bag = byPolicy.get(key);
    if (!bag) {
      bag = CSL.Assets.new();
      byPolicy.set(key, bag);
    }
    bag.insert(
      CSL.AssetName.new(Buffer.from(a.nameHex, 'hex')),
      CSL.BigNum.from_str(a.qty),
    );
    ma.insert(policyHash, bag);
  }
  return ma;
}

export function buildBody(args: BuildTxArgs): CSL.TransactionBody {
  const ins = CSL.TransactionInputs.new();
  for (const i of args.inputs) {
    ins.add(CSL.TransactionInput.new(
      CSL.TransactionHash.from_bytes(Buffer.from(i.txHash, 'hex')),
      i.outputIndex,
    ));
  }
  const outs = CSL.TransactionOutputs.new();
  for (const o of args.outputs) {
    const v = CSL.Value.new(CSL.BigNum.from_str(o.lovelace));
    if (o.assets?.length) v.set_multiasset(buildMultiAsset(o.assets));
    outs.add(CSL.TransactionOutput.new(
      CSL.Address.from_bech32(o.address),
      v,
    ));
  }
  const fee = CSL.BigNum.from_str(args.fee ?? '200000');
  const body = CSL.TransactionBody.new(ins, outs, fee);
  if (args.ttlSlot != null) body.set_ttl(CSL.BigNum.from_str(String(args.ttlSlot)));
  if (args.validityStartSlot != null) {
    body.set_validity_start_interval_bignum(CSL.BigNum.from_str(String(args.validityStartSlot)));
  }
  return body;
}

export interface SignedTx {
  /** Full signed tx as CBOR hex. */
  cborHex: string;
  /** Lowercase hex tx hash (FixedTransaction-stable). */
  txHash: string;
}

export function signTx(body: CSL.TransactionBody, signers: CSL.PrivateKey[]): SignedTx {
  const ftx = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes());
  const hash = ftx.transaction_hash();
  const wits = CSL.TransactionWitnessSet.new();
  if (signers.length > 0) {
    const vkeys = CSL.Vkeywitnesses.new();
    for (const k of signers) {
      const sig = k.sign(hash.to_bytes());
      const pub = k.to_public();
      vkeys.add(CSL.Vkeywitness.new(CSL.Vkey.new(pub), sig));
    }
    wits.set_vkeys(vkeys);
  }
  const tx = CSL.Transaction.new(body, wits);
  return {
    cborHex: Buffer.from(tx.to_bytes()).toString('hex'),
    txHash:  Buffer.from(hash.to_bytes()).toString('hex').toLowerCase(),
  };
}

/** Build an *unsigned* tx (empty witness set) — for the no-witness check. */
export function buildUnsigned(body: CSL.TransactionBody): SignedTx {
  const ftx = CSL.FixedTransaction.new_from_body_bytes(body.to_bytes());
  const hash = ftx.transaction_hash();
  const tx = CSL.Transaction.new(body, CSL.TransactionWitnessSet.new());
  return {
    cborHex: Buffer.from(tx.to_bytes()).toString('hex'),
    txHash:  Buffer.from(hash.to_bytes()).toString('hex').toLowerCase(),
  };
}
