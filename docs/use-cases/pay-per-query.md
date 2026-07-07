# Use case: pay-per-query data services

An ERP or backend system holds data other companies will pay for: live
prices, stock levels, credit ratings, logistics status. Selling it
today means partner onboarding, API-key contracts, monthly invoicing
and reconciliation, overhead that only pays off for large consumers.

With `@odatano/x402`, the same SAP CAP / OData service charges **per
request** instead: every gated call returns HTTP 402 with the price
until the caller settles it on Cardano. No account, no API key, no
invoice. The payment itself is the contract, the receipt, and the
audit record, verifiable by both sides on the public ledger.

## The flow

```
Buyer                          Seller (SAP CAP + @odatano/x402)
  │  GET /odata/v4/prices/Quotes  │
  │──────────────────────────────▶│
  │  402 { price: 1 ADA, payTo }  │
  │◀──────────────────────────────│
  │  build + sign payment tx      │
  │  GET ... + PAYMENT-SIGNATURE  │
  │──────────────────────────────▶│  verify → submit → settle on chain
  │  200 + data + tx hash receipt │
  │◀──────────────────────────────│  receipt row persisted
```

The seller side is one hook in the service:

```typescript
gateService(this, {
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  routePricing: {
    Quotes: [
      { amount: '1000000' },                                  // 1 ADA
      { amount: '100000', asset: '<policy>.<nameHex>' },      // or 0.1 USDM
    ],
  },
  receipts: true,
});
```

## Run it

The reference implementation is [`examples/cap-app`](../../examples/cap-app/)
(seller) + [`examples/node-buyer`](../../examples/node-buyer/) (buyer).
One command runs the whole round-trip on a testnet:

```bash
NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx npm run demo
```

## Accounting without an invoicing run

With `receipts: true`, every settled payment lands as a row the seller
can query, here exposed as a free OData view:

```bash
curl -s "http://localhost:4004/odata/v4/prices/Settlements" | jq .
```

Each row carries the tx hash (the on-chain join key), payer, amount,
asset, route and the replay nonce. There is nothing to reconcile: the
row is written only after settlement confirmed on chain.

## Variants of the same pattern

- **B2B lookups without onboarding**, credit checks, compliance or
  logistics-status lookups where a business partner pays per lookup on
  the spot. Same gate, different entity; the partner needs a wallet,
  not a contract.
- **Monetized reports and analytics**, price individual actions
  instead of entities (`getBestPrice: '2000000'` in `routePricing`).
  Any internal CAP action becomes a revenue stream.
- **Metered premium tiers**, `routePricing` accepts a resolver
  function: return `null` for allow-listed internal callers, a price
  for everyone else (see [`docs/usage.md`](../usage.md), dynamic
  pricing).

## Pricing notes

- **Lovelace prices have a floor.** The payment is a real on-chain
  output, and Cardano's min-UTxO (~0.98 ADA on current parameters)
  makes anything below ~1 ADA unpayable. Price in ADA at ≥ 1 ADA.
- **Native-asset prices don't.** A 0.1 USDM price is fine, the
  payment output carries its own min-ADA on top. For sub-ADA unit
  prices, price in a stablecoin (multi-accept lets you offer both).

## Toward production

- Verify + settle run in-process by default (`localFacilitator`); a
  hosted [facilitator](../facilitator-protocol.md) centralizes chain
  access for many services.
- Grants (`X-PAYMENT-GRANT`) turn one payment into N seconds of
  access, pay-per-session instead of pay-per-call.
- The buyer side works from any stack that can sign a Cardano tx: CLI,
  browser wallet (CIP-30), or an AI agent
  ([AI agent payments](./ai-agent-payments.md)).
