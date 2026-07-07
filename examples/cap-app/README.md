# @odatano/x402-example-cap-app

A pay-per-query data service on SAP CAP: a price feed sold per request
instead of per API-key contract. Every settled payment lands as a row
in a free `Settlements` view — the seller's accounting without an
invoicing run, the payment itself is the receipt.

## What it shows

- Plugin auto-discovery: no explicit `import '@odatano/x402'` in `srv/server.ts`. CAP finds `cds-plugin.js` in `node_modules/@odatano/x402/`.
- `gateService()` registering a `before('*')` handler on `PricesService`.
- `routePricing` keyed by CAP event name (entity or action).
- Multi-accept pricing: `Quotes` is payable in ADA *or* a native asset (set `X402_TOKEN_ASSET=<policy>.<nameHex>` and `X402_TOKEN_AMOUNT`).
- `receipts: true` persisting one row per settled payment into `odatano.x402.X402Receipts`, exposed as the read-only `Settlements` projection.
- `onAccepted` callback for consumer-side audit.

## Routes

| Route | Method | Price | Notes |
|---|---|---|---|
| `/odata/v4/prices/Quotes` | GET | 1 ADA (or token) | gated, multi-accept |
| `/odata/v4/prices/Quotes(<ID>)` | GET | 1 ADA (or token) | gated |
| `/odata/v4/prices/getBestPrice(pair='ADA-USD')` | POST | 2 ADA | gated |
| `/odata/v4/prices/Settlements` | GET | - | **free** — one row per settled payment |
| `/odata/v4/prices/Health` | GET | - | **free** (absent from routePricing) |
| `/health` | GET | - | CAP-built-in health |
| `/$metadata` | GET | - | bypass regex |

## Quick start

```bash
cd examples/cap-app
npm install
# The gate settles on chain, so the seller needs a Cardano backend:
NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx npm run watch
```

## Probe the gate

```bash
# Free route: 200
curl http://localhost:4004/odata/v4/prices/Health

# Gated route: 402 with v2 body
curl -s http://localhost:4004/odata/v4/prices/Quotes | jq .

# Gated action: 402
curl -s -X POST http://localhost:4004/odata/v4/prices/getBestPrice \
  -H 'Content-Type: application/json' \
  -d '{"pair":"ADA-USD"}' | jq .
```

The 402 response body looks like:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "cardano:preprod",
    "asset": "lovelace",
    "amount": "1000000",
    "payTo": "addr_test1qqetxfc...",
    "resource": {
      "url": "/odata/v4/prices/Quotes",
      "description": "Example: synthetic price feed",
      "mimeType": "application/json"
    },
    "assetTransferMethod": "default",
    "maxTimeoutSeconds": 600
  }]
}
```

## Paying for a request

Use one of the buyer examples against this seller:

- [`examples/node-buyer`](../node-buyer/) — headless CLI buyer, the fastest full round-trip
- [`examples/agent-buyer`](../agent-buyer/) — MCP server so an AI agent buys autonomously
- [`examples/browser-buyer`](../browser-buyer/) — CIP-30 wallet in the browser

Rolling your own: build an unsigned tx with `buildUnsignedPaymentTx`, sign it,
base64-encode the signed CBOR + nonce-UTxO ref into a `PAYMENT-SIGNATURE`
header, and retry. On success: `200 OK` + `X-PAYMENT-RESPONSE` header.

## Seller-side accounting

Every settled payment is persisted (`receipts: true`) and readable for free:

```bash
curl -s "http://localhost:4004/odata/v4/prices/Settlements?\$select=txHash,amount,asset,route" | jq .
```

```json
{
  "value": [{
    "txHash": "aa2613ef7e49224a927a5041ceb1634b8d30dc825e37ca723a220a5331ba5259",
    "amount": "1000000",
    "asset": "lovelace",
    "route": "/odata/v4/prices/Quotes"
  }]
}
```

The row is written after settle confirms and before the buyer gets the 200;
the canonical record stays on chain (the tx hash is the join key).
