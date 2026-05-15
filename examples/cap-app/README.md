# @odatano/x402-example-cap-app

Minimal CAP application demonstrating `@odatano/x402` plugin integration.

## What it shows

- Plugin auto-discovery: no explicit `import '@odatano/x402'` in `srv/server.ts`. CAP finds `cds-plugin.js` in `node_modules/@odatano/x402/`.
- `gateService()` registering a `before('*')` handler on `PricesService`.
- `routePricing` keyed by CAP event name (entity or action).
- `onAccepted` callback for consumer-side audit.

## Routes

| Route | Method | Price | Notes |
|---|---|---|---|
| `/odata/v4/prices/Quotes` | GET | 0.5 ADA | gated |
| `/odata/v4/prices/Quotes(<ID>)` | GET | 0.5 ADA | gated |
| `/odata/v4/prices/getBestPrice(pair='ADA-USD')` | POST | 1 ADA | gated |
| `/odata/v4/prices/Health` | GET | - | **free** (absent from routePricing) |
| `/health` | GET | - | CAP-built-in health |
| `/$metadata` | GET | - | bypass regex |

## Quick start

```bash
cd examples/cap-app
npm install
npm run watch
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
    "amount": "500000",
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

The example doesn't include a buyer wallet. To exercise the paid flow:

1. Build an unsigned tx server-side with `buildUnsignedPaymentTx({ buyerBech32, requirements })`
2. Sign it via your CIP-30 wallet or a CLI
3. base64-encode the signed CBOR and the nonce-UTxO ref into a `PAYMENT-SIGNATURE` header:
   ```json
   { "x402Version": 2, "scheme": "exact", "network": "cardano:preprod",
     "payload": { "transaction": "<base64-cbor>", "nonce": "<txHash>#<idx>" } }
   ```
4. Retry the original request with that header. On success: `200 OK` + `X-PAYMENT-RESPONSE` header.
