# Protocol: buyer flow + envelope shape + facilitator checks

How a gated request actually plays out on the wire, and what the facilitator validates before it accepts a payment.

## The buyer flow

```
        Server                              Buyer (browser / CLI)
          │                                       │
          │  ◄── GET /odata/v4/prices/Quotes ─────│
          │                                       │
          │ ──── 402 + accepts[0] (price, payTo) ►│
          │                                       │
          │                              ┌────────┴────────┐
          │                              │ build tx        │
          │                              │ sign via CIP-30 │
          │                              │ base64-encode   │
          │                              └────────┬────────┘
          │                                       │
          │  ◄── GET /odata/v4/prices/Quotes ─────│
          │        PAYMENT-SIGNATURE: <base64>    │
          │                                       │
   ┌──────┴──────┐                                │
   │ 6 checks    │                                │
   │ + submit    │                                │
   │ + poll      │                                │
   │ + onAccepted│                                │
   └──────┬──────┘                                │
          │                                       │
          │ ─────── 200 OK + data ───────────────►│
          │   X-PAYMENT-RESPONSE: <base64>        │
```

## `PAYMENT-SIGNATURE` envelope

The header value is the base64 encoding of:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "cardano:preprod",
  "payload": {
    "transaction": "<base64-CBOR of signed tx>",
    "nonce":       "<txHash>#<outputIndex>"
  }
}
```

The `nonce` references a UTxO that **must also appear as an input of the payment tx**. Once the tx settles, that UTxO is consumed; replay defense is on-chain, no DB table needed.

## Six mandatory facilitator checks

Every accepted payment passes all six (in order):

| # | Check | Code on failure |
|---|---|---|
| 1 | Network matches requirements | `network_mismatch` |
| 2 | At least one output to `payTo` | `wrong_recipient` |
| 3 | Sum of payTo outputs for asset ≥ required | `insufficient_amount` |
| 4 | Exact policy + asset-name match | `wrong_asset` |
| 5 | Nonce UTxO referenced as tx input **and** unspent on chain | `nonce_not_referenced` / `replay_detected` |
| 6 | Validity-range upper bound still in future | `expired_ttl` |

Plus a sanity guard: tx has at least one vkey witness → `unsigned_transaction`.

Rejected requests get `402` with an `error` field of the form `"<base> (<code>): <reason>"` so clients can parse the code without breaking wire format.

The full list of `code` values lives in [`facilitator-protocol.md`](facilitator-protocol.md#canonical-code-values).

## What is x402, briefly

[x402](https://www.x402.org/) is the dormant HTTP `402 Payment Required` status code, revived. Servers respond `402` with a machine-readable body describing the price, asset, and recipient. Clients build, sign, and submit a payment, then retry the request with a `PAYMENT-SIGNATURE` header. Settlement happens on-chain.

The original x402 spec is Coinbase / EVM-flavoured. The **Cardano-x402-v2** spec (in progress at [masumi-network/x402-cardano](https://github.com/masumi-network/x402-cardano)) adapts it to Cardano's UTxO model. This library is a from-scratch v2 implementation in TypeScript.
