# Protocol: x402 v2 on Cardano

How a gated request plays out on the wire, and what the facilitator checks
before a payment is accepted. The library implements x402 v2 with the
Cardano `exact` scheme (assetTransferMethods `default` and `script`) over
the HTTP transport.

## The flow (`authorization`)

```
        Resource server                         Buyer (browser / CLI / agent)
              │                                          │
              │  ◄────────── GET /odata/v4/prices/Quotes │
              │                                          │
              │ ── 402 + PAYMENT-REQUIRED ─────────────► │
              │                                 build + sign tx (not broadcast)
              │  ◄── GET + PAYMENT-SIGNATURE ─────────── │
              │                                          │
   facilitator /verify   (read-only)                     │
   protected handler runs                                │
   facilitator /settle   (submit, wait for confirmations)│
              │                                          │
              │ ── 200 + data + PAYMENT-RESPONSE ──────► │
```

The handler runs between verify and settle. A handler that fails (status
400 or higher, or a CAP error) is never settled, so the buyer is not
charged. A settle that fails replaces the handler's answer with a 402.

What the handler did stays done: in CAP its transaction is committed
before settlement, so the database connection is free while the gate
waits for confirmations. After a pending answer the buyer re-sends the
payment and the handler runs again, so a gated handler should be safe to
repeat.

## Headers

All three carry base64-encoded JSON.

| Header | Direction | Content |
|---|---|---|
| `PAYMENT-REQUIRED` | server → buyer | `PaymentRequired` |
| `PAYMENT-SIGNATURE` | buyer → server | `PaymentPayload` |
| `PAYMENT-RESPONSE` | server → buyer | `SettlementResponse` |

The 402 body repeats `PaymentRequired` for clients that read bodies, but
the header is the protocol.

### `PaymentRequired`

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": { "url": "/odata/v4/prices/Quotes", "description": "Synthetic price feed", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact",
    "network": "cardano:preprod",
    "asset": "lovelace",
    "amount": "1000000",
    "payTo": "addr_test1...",
    "maxTimeoutSeconds": 600,
    "extra": { "areFeesSponsored": false }
  }]
}
```

`resource` describes the route once; `accepts[]` lists the ways to pay.
`extra.assetTransferMethod` selects `default` (absent) or `script`.
`extra.confirmationPolicy.l1Confirmations` (-1..20, default 1) sets how
much chain evidence settle waits for. `areFeesSponsored` is always false:
the buyer pays the network fee.

### `PaymentPayload`

```json
{
  "x402Version": 2,
  "resource": { "url": "/odata/v4/prices/Quotes" },
  "accepted": { "scheme": "exact", "network": "cardano:preprod", "...": "the chosen accepts[] entry, verbatim" },
  "payload": {
    "transaction": "<base64 CBOR of the signed, unbroadcast tx>",
    "nonce": "<txHash>#<outputIndex>"
  }
}
```

`accepted` must equal one of the offered entries exactly, so requirements
a `PriceResolver` returns must be the same on the paid retry. The `nonce`
is a buyer UTxO the transaction spends: once the payment lands it is
consumed, which makes replay impossible on chain. The buyer echoes the
`extensions` of `PaymentRequired`.

### `SettlementResponse`

```json
{
  "success": true,
  "transaction": "<tx hash>",
  "network": "cardano:preprod",
  "payer": "addr_test1...",
  "amount": "1000000",
  "extra": { "status": "confirmed", "confirmations": 1, "transactionId": "<tx hash>" }
}
```

On failure `success` is false and `errorReason` names the reason; the
answer is a 402 carrying both `PAYMENT-RESPONSE` and `PAYMENT-REQUIRED`.

### HTTP status

| Situation | Status |
|---|---|
| no `PAYMENT-SIGNATURE` | 402 |
| malformed payload (not base64 JSON, wrong version or scheme, bad nonce, undecodable tx) | 400 |
| `accepted` not offered, verification failed, settlement failed or pending | 402 |
| settled | the handler's status, with `PAYMENT-RESPONSE` |

## Verification rules

The facilitator rejects a payment unless all hold. `...` stands for
`invalid_exact_cardano_payload`.

| # | Rule | Code |
|---|---|---|
| 1 | Body network id and every output address belong to the requirement's network | `..._network_id_mismatch` |
| 2 | An output pays `payTo` | `..._recipient_mismatch` |
| 3 | One output to `payTo` alone carries at least `amount` | `..._amount_insufficient` |
| 4 | That output carries exactly `asset` (policy and name) | `..._asset_mismatch` |
| 5 | The nonce is an input; every input exists and is unspent | `..._nonce_not_in_inputs`, `..._nonce_not_on_chain`, `..._input_not_available` |
| 6 | Every vkey signature verifies and every key-locked input is signed; inputs = outputs + fee per asset; fee ≥ `minFeeB + minFeeA * size`; no mint, withdrawals, certificates, governance or donation; validity start reached; the transaction is not marked as failing its scripts | `..._invalid_signature`, `..._unsigned`, `..._value_not_conserved`, `..._fee_below_minimum`, `..._phase1_invalid`, `..._not_yet_valid`, `..._phase2_invalid` |
| 7 | A TTL is set, not passed, and not beyond now + `maxTimeoutSeconds` | `..._ttl_expired`, `..._ttl_too_far` |
| 8 | The `payTo` output holds the min-UTxO for its size | `..._min_utxo_insufficient` |
| 9 | Settle reaches `confirmationPolicy` | `settlement_pending` until then |

The codes are those of the `@x402/cardano` reference implementation, so
clients of either implementation see the same reasons. Unsupported
transfer methods are rejected with `invalid_exact_cardano_requirements`, a network the facilitator's
backend is not on with `invalid_network`.

### Script transfers

For `extra.assetTransferMethod: 'script'` the facilitator also requires:

| Check | Code |
|---|---|
| `payTo` is the address of the script from `extra.scriptHash`, or from `extra.script` plus `extra.parameters` | `..._script_address_mismatch` |
| `extra.datum` set → an output to `payTo` carries an inline datum | `..._datum_missing` |
| … and that datum equals `extra.datum` as PlutusData | `..._datum_mismatch` |

Whether the datum suits the contract is not checked; a resource server
that needs more passes `verifyTransfer` to the middleware
(`transfer_rejected`).

## Settlement

- **Confirmations.** Settle waits, bounded, until the transaction is
  `l1Confirmations` blocks deep (default 1). `-1` (broadcast accepted)
  must be enabled on the facilitator (`allowMempoolConfirmation`), since
  such a payment can still be rolled back.
- **Pending.** Below the threshold settle answers `success: false`,
  `errorReason: settlement_pending` with the transaction id. The buyer
  re-sends the same `PAYMENT-SIGNATURE`, never a new payment;
  `x402Fetch` and `x402Axios` do this automatically. The facilitator
  resumes observing. A transaction a backend took is never submitted
  again; one whose submit got no clear answer (rate limit, outage) is
  submitted again on the retry, so it cannot be stranded.
- **One delivery per payment.** Settle claims the transaction id before
  the first submit. A second settle of a settled transaction, or of one
  another call is working on, answers `duplicate_settlement`. A call
  holds its claim for its wait plus 30 seconds; if it dies, a retry takes
  over after that. Claims are kept until the transaction can no longer
  land. All gates of a process share one facilitator by default; several
  instances must share the claim store (`cdsSettlementStore`, or the
  `settlements` option of `gateService`).
- **Failure.** A ledger rejection is
  `exact_cardano_settlement_definitively_rejected`; a transaction still
  missing two minutes after its TTL is `exact_cardano_settlement_failed`;
  one that landed as a failed script run (collateral taken, no payment
  output) is `invalid_exact_cardano_payload_phase2_invalid`.

## What is x402, briefly

[x402](https://www.x402.org/) revives the HTTP `402 Payment Required`
status: the server says what a resource costs, the client pays and
retries with proof of payment, settlement happens on chain. The Cardano
`exact` scheme adapts it to the UTxO model: `cardano:mainnet|preprod|preview`
networks (CIP-34 forms accepted as aliases), `<policyId>.<assetNameHex>`
assets, and a signed transaction as the payment.
