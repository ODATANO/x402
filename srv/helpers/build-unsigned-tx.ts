/**
 * Server-side unsigned payment-tx builder for browser-buyer flows.
 *
 * The browser knows the buyer's bech32 (via CIP-30) but not the
 * signing keys. Replicating CSL coin-selection + protocol-params
 * fetch in the browser would mean shipping ~2 MB of WASM. So we
 * build the unsigned tx server-side, return the CBOR for the
 * wallet to sign, and let the browser submit the signed CBOR as
 * `payload.transaction` in the PAYMENT-SIGNATURE envelope.
 *
 * Diff vs v1 of CHAINFEED's same-named helper:
 *   - Asset-agnostic — parses requirements.asset as a v2 string
 *     (`'lovelace'` or `'<policy>.<nameHex>'`).
 *   - Returns `nonceRef` alongside the unsigned CBOR — the server
 *     picks one of the buyer's chosen inputs as the v2 nonce UTxO,
 *     so the browser doesn't have to reason about it.
 *
 * **x402-spec deviation:** strict v2 has the buyer construct the
 * tx end-to-end. This helper is a "self-facilitator" pattern: the
 * server builds, the buyer signs, the server still validates the
 * signed tx against requirements before settling. Same security
 * model (the buyer's signature still authorises the spend), easier
 * browser ergonomics.
 */

import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import * as bridge from '../bridge';
import type { PaymentRequirementEntry } from '../core/types';
import { parseAsset } from '../core/asset';

interface ProtoParams {
  minFeeA:          number | string;
  minFeeB:          number | string;
  poolDeposit:      number | string;
  keyDeposit:       number | string;
  maxValSize:       number | string;
  maxTxSize:        number | string;
  coinsPerUtxoSize: number | string;
}

export interface BuildUnsignedTxArgs {
  /** Buyer's bech32 address (must be Base or Enterprise with VKey-hash payment cred). */
  buyerBech32: string;
  /** A single accepts[] entry — call `flatRequirements(body)` to extract. */
  requirements: PaymentRequirementEntry;
  /**
   * Optional TTL in slots from "now" (= current chain tip slot).
   * Default 1800 (≈30 min on Cardano's 1s-slot networks).
   */
  ttlSlotsFromNow?: number;
}

export interface UnsignedTxResult {
  /** CBOR hex of the unsigned tx (empty witness set). Ready for CIP-30 signTx. */
  unsignedTxCborHex: string;
  /** Hex tx hash — what the buyer's wallet will display. */
  txHashHex:         string;
  /** Buyer's payment-cred VKey hash — wallet must sign for this. */
  requiredSignerHex: string;
  /** v2 nonce reference `<txHash>#<index>`, picked from the buyer's chosen inputs. */
  nonceRef:          string;
  /** Echo of the inputs chosen so the buyer's UI can show "spends these UTxOs". */
  inputs: Array<{ txHash: string; outputIndex: number; lovelace: string }>;
  /** TTL slot used for the validity-range upper bound. */
  ttlSlot:           number;
}

export async function buildUnsignedPaymentTx(
  args: BuildUnsignedTxArgs,
): Promise<UnsignedTxResult> {
  const { buyerBech32, requirements } = args;

  // 1. Decode buyer address; derive payment-cred VKey hash.
  let buyerAddress: CSL.Address;
  try { buyerAddress = CSL.Address.from_bech32(buyerBech32); }
  catch { throw new Error(`buildUnsignedPaymentTx: invalid bech32 address: ${buyerBech32}`); }

  const baseAddr       = CSL.BaseAddress.from_address(buyerAddress);
  const enterpriseAddr = CSL.EnterpriseAddress.from_address(buyerAddress);
  const paymentCred    = baseAddr?.payment_cred() ?? enterpriseAddr?.payment_cred();
  if (!paymentCred) {
    throw new Error('buildUnsignedPaymentTx: only Base / Enterprise addresses are supported');
  }
  const buyerVkeyHash = paymentCred.to_keyhash();
  if (!buyerVkeyHash) {
    throw new Error('buildUnsignedPaymentTx: payment credential must be a VKey hash, not a script');
  }
  const requiredSignerHex = Buffer.from(buyerVkeyHash.to_bytes()).toString('hex');

  // 2. Fetch buyer UTxOs + protocol params + current slot in parallel.
  const [utxos, params, currentSlot] = await Promise.all([
    bridge.getUtxosAtAddress(buyerBech32),
    bridge.getProtocolParameters() as Promise<ProtoParams>,
    bridge.getCurrentSlot(),
  ]);
  if (utxos.length === 0) {
    throw new Error(`buildUnsignedPaymentTx: no UTxOs at ${buyerBech32}`);
  }

  // 3. Pick the input(s) for coin-selection.
  //    Strategy:
  //      - If lovelace asset: pick largest-ADA UTxO; add second-largest as padding if first < 3 ADA.
  //      - If native asset:   pick largest-ADA UTxO that ALSO holds enough of the asset;
  //                           add padding the same way.
  const parsedAsset = parseAsset(requirements.asset);
  const required = BigInt(requirements.amount);

  const sortedByAda = [...utxos].sort(
    (a, b) => (BigInt(b.lovelace) - BigInt(a.lovelace) > 0n ? 1 : -1),
  );

  let inputs: typeof utxos;
  if (parsedAsset.isLovelace) {
    // ADA payment: largest UTxO must cover required + fees + min-ADA change.
    // Heuristic: required + 2_000_000 (≈2 ADA fee+change headroom).
    const headroom = required + 2_000_000n;
    const ok = sortedByAda.find(u => BigInt(u.lovelace) >= headroom);
    if (!ok) {
      throw new Error(`buildUnsignedPaymentTx: no UTxO at ${buyerBech32} with ≥ ${headroom} lovelace`);
    }
    inputs = [ok];
  } else {
    const candidates = sortedByAda.filter(u =>
      u.assets.some(a => a.unit === parsedAsset.unit && BigInt(a.quantity) >= required),
    );
    if (candidates.length === 0) {
      throw new Error(
        `buildUnsignedPaymentTx: no UTxO at ${buyerBech32} holds ≥ ${required} of ${parsedAsset.unit}`,
      );
    }
    const tokenInput = candidates[0]!;
    inputs = [tokenInput];
    if (BigInt(tokenInput.lovelace) < 3_000_000n) {
      const padding = sortedByAda.find(u => u !== tokenInput);
      if (!padding) {
        throw new Error('buildUnsignedPaymentTx: no second UTxO available to fund fees');
      }
      inputs.push(padding);
    }
  }

  // 4. Configure CSL TransactionBuilder from live protocol params.
  const builder = CSL.TransactionBuilder.new(
    CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(CSL.LinearFee.new(
        CSL.BigNum.from_str(String(params.minFeeA)),
        CSL.BigNum.from_str(String(params.minFeeB)),
      ))
      .pool_deposit(CSL.BigNum.from_str(String(params.poolDeposit)))
      .key_deposit(CSL.BigNum.from_str(String(params.keyDeposit)))
      .max_value_size(Number(params.maxValSize))
      .max_tx_size(Number(params.maxTxSize))
      .coins_per_utxo_byte(CSL.BigNum.from_str(String(params.coinsPerUtxoSize)))
      .build(),
  );

  // 5. Wire inputs (preserve full multi-asset payload).
  for (const u of inputs) {
    const inMa = CSL.MultiAsset.new();
    const byPolicy = new Map<string, Array<{ name: string; qty: string }>>();
    for (const a of u.assets) {
      const arr = byPolicy.get(a.policyId) ?? [];
      arr.push({ name: a.assetNameHex, qty: a.quantity });
      byPolicy.set(a.policyId, arr);
    }
    for (const [policyHex, items] of byPolicy) {
      const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(policyHex, 'hex'));
      const assetMap = CSL.Assets.new();
      for (const { name, qty } of items) {
        assetMap.insert(
          CSL.AssetName.new(Buffer.from(name, 'hex')),
          CSL.BigNum.from_str(qty),
        );
      }
      inMa.insert(policyHash, assetMap);
    }
    const inV = CSL.Value.new(CSL.BigNum.from_str(u.lovelace));
    if (u.assets.length) inV.set_multiasset(inMa);
    builder.add_key_input(
      buyerVkeyHash,
      CSL.TransactionInput.new(
        CSL.TransactionHash.from_bytes(Buffer.from(u.txHash, 'hex')),
        u.outputIndex,
      ),
      inV,
    );
  }

  // 6. Output to payTo.
  const payToAddr = CSL.Address.from_bech32(requirements.payTo);
  let payOut: CSL.TransactionOutput;
  if (parsedAsset.isLovelace) {
    const v = CSL.Value.new(CSL.BigNum.from_str(required.toString()));
    payOut = CSL.TransactionOutput.new(payToAddr, v);
  } else {
    const payOutMa  = CSL.MultiAsset.new();
    const payAssets = CSL.Assets.new();
    const policyHash = CSL.ScriptHash.from_bytes(Buffer.from(parsedAsset.policyId, 'hex'));
    payAssets.insert(
      CSL.AssetName.new(Buffer.from(parsedAsset.assetNameHex, 'hex')),
      CSL.BigNum.from_str(required.toString()),
    );
    payOutMa.insert(policyHash, payAssets);
    const payOutV = CSL.Value.new(CSL.BigNum.from_str('0'));
    payOutV.set_multiasset(payOutMa);
    const provisional = CSL.TransactionOutput.new(payToAddr, payOutV);
    const minAda = CSL.min_ada_for_output(
      provisional,
      CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(String(params.coinsPerUtxoSize))),
    );
    payOutV.set_coin(minAda);
    payOut = CSL.TransactionOutput.new(payToAddr, payOutV);
  }
  builder.add_output(payOut);

  // 7. TTL (slot of upper bound). Default 1800 slots ≈ 30 min.
  const ttlSlot = currentSlot + (args.ttlSlotsFromNow ?? 1800);
  builder.set_ttl_bignum(CSL.BigNum.from_str(String(ttlSlot)));

  // 8. Change to buyer.
  builder.add_change_if_needed(buyerAddress);

  // 9. Build body, compute hash, return unsigned tx.
  const txBody = builder.build();
  const txHash = CSL.FixedTransaction.new_from_body_bytes(txBody.to_bytes()).transaction_hash();

  const emptyWits = CSL.TransactionWitnessSet.new();
  const unsigned  = CSL.Transaction.new(txBody, emptyWits);

  // Pick the first input as the v2 nonce UTxO.
  // It MUST appear in tx.inputs (which it does by construction) and be
  // unspent (which it is — we just queried it from the buyer's UTxO set).
  const nonceInput = inputs[0]!;
  const nonceRef = `${nonceInput.txHash}#${nonceInput.outputIndex}`;

  return {
    unsignedTxCborHex: Buffer.from(unsigned.to_bytes()).toString('hex'),
    txHashHex:         Buffer.from(txHash.to_bytes()).toString('hex').toLowerCase(),
    requiredSignerHex,
    nonceRef,
    inputs: inputs.map(i => ({ txHash: i.txHash, outputIndex: i.outputIndex, lovelace: i.lovelace })),
    ttlSlot,
  };
}
