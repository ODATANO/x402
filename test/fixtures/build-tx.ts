/**
 * Build deterministic signed Cardano transactions for tests.
 *
 * We construct the TxBody directly (no coin selection, no protocol-params
 * fetch) so the fixtures are reproducible across CI environments and need
 * no chain backend. Tests that need a specific shape (multiple outputs,
 * lovelace-only, missing TTL, etc.) compose these helpers.
 *
 * Built with `@harmoniclabs/buildooor` — the same stack @odatano/core's
 * `parseTransaction` uses — so the suite carries no CSL dependency and the
 * body hash here is exactly what `srv/core/decode.ts` will recompute.
 */

import {
  Tx,
  TxBody,
  TxOut,
  UTxO,
  Value,
  Address,
  Hash32,
  TxWitnessSet,
  VKeyWitness,
  Signature,
  signEd25519_sync,
} from '@harmoniclabs/buildooor';

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

function buildValue(lovelace: string, assets?: TestAsset[]): Value {
  let v = Value.lovelaces(BigInt(lovelace));
  for (const a of assets ?? []) {
    v = Value.add(v, Value.singleAsset(a.policyId, Buffer.from(a.nameHex, 'hex'), BigInt(a.qty)));
  }
  return v;
}

export function buildBody(args: BuildTxArgs): TxBody {
  // A TxBody input is a *resolved* UTxO in the Buildooor model, but the
  // body CBOR only encodes the out-ref, so the `resolved` side is a
  // throwaway (any address/value); nothing in the decode path reads it.
  const resolvedAddr = Address.fromString(args.outputs[0]!.address);

  const inputs = args.inputs.map(i => new UTxO({
    utxoRef: { id: i.txHash, index: i.outputIndex },
    resolved: new TxOut({ address: resolvedAddr, value: Value.lovelaces(10_000_000n) }),
  })) as [UTxO, ...UTxO[]];

  const outputs = args.outputs.map(o => new TxOut({
    address: Address.fromString(o.address),
    value: buildValue(o.lovelace, o.assets),
  }));

  return new TxBody({
    inputs,
    outputs,
    fee: BigInt(args.fee ?? '200000'),
    ...(args.ttlSlot != null ? { ttl: BigInt(args.ttlSlot) } : {}),
    ...(args.validityStartSlot != null
      ? { validityIntervalStart: BigInt(args.validityStartSlot) }
      : {}),
  });
}

export interface SignedTx {
  /** Full signed tx as CBOR hex. */
  cborHex: string;
  /** Lowercase hex tx hash (body hash, byte-stable). */
  txHash: string;
}

function txToHex(body: TxBody, vkeyWitnesses: VKeyWitness[]): string {
  const tx = new Tx({ body, witnesses: new TxWitnessSet({ vkeyWitnesses }) });
  return Buffer.from(tx.toCborBytes()).toString('hex');
}

export function signTx(body: TxBody, signers: Uint8Array[]): SignedTx {
  const hashBytes = body.hash.toBuffer();
  const vkeyWitnesses = signers.map(key => {
    const { pubKey, signature } = signEd25519_sync(hashBytes, key);
    return new VKeyWitness({
      vkey: new Hash32(Buffer.from(pubKey)),
      signature: new Signature(Buffer.from(signature)),
    });
  });
  return {
    cborHex: txToHex(body, vkeyWitnesses),
    txHash:  body.hash.toString().toLowerCase(),
  };
}

/** Build an *unsigned* tx (empty witness set), for the no-witness check. */
export function buildUnsigned(body: TxBody): SignedTx {
  return {
    cborHex: txToHex(body, []),
    txHash:  body.hash.toString().toLowerCase(),
  };
}
