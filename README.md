# @odatano/x402

x402 payment gating for SAP CAP applications, backed by Cardano.

Wire a single `before('*')` hook into your CAP service and every gated request returns **HTTP 402 Payment Required** until the caller proves on-chain settlement. Asset-agnostic — pay in ADA, USDM, or any native asset.

Implements the **Cardano-x402-v2** spec on top of [`@odatano/core`](https://www.npmjs.com/package/@odatano/core).

---

## What is x402?

[x402](https://www.x402.org/) is the dormant HTTP `402 Payment Required` status code, revived. Servers respond `402` with a machine-readable body describing the price, asset, and recipient. Clients build, sign, and submit a payment, then retry the request with a `PAYMENT-SIGNATURE` header. Settlement happens on-chain.

The original x402 spec is Coinbase / EVM-flavoured. The **Cardano-x402-v2** spec (in progress at [masumi-network/x402-cardano](https://github.com/masumi-network/x402-cardano)) adapts it to Cardano's UTxO model. This library is a from-scratch v2 implementation in TypeScript.

---

## Install

```bash
npm install @odatano/x402 @odatano/core
```

`@odatano/core` (the Cardano bridge) is a peer dependency — install whichever version meets `>=1.7.8`.

---

## Quick Start — CAP service gate

```typescript
// srv/prices-service.ts
import cds from '@sap/cds';
import { gateService } from '@odatano/x402';

export class PricesService extends cds.ApplicationService {
  async init() {
    gateService(this, {
      payTo:   'addr_test1...your-preprod-address...',
      network: 'cardano:preprod',
      asset:   'lovelace',                  // or '<policy>.<nameHex>' for native tokens
      routePricing: {
        Quotes:        '500000',            // 0.5 ADA per Quotes read
        getBestPrice:  '1000000',           // 1 ADA per getBestPrice action call
      },
      description: 'Synthetic price feed',
      onAccepted: async (claim, req) => {
        // Optional audit — runs once per accepted payment, after settlement.
        // Errors here are logged but don't block the response.
        console.log(`paid ${claim.amountUnits} ${claim.asset} (tx=${claim.txHash})`);
      },
    });
    return super.init();
  }
}
```

Configure the Cardano backend in `package.json`:

```jsonc
{
  "cds": {
    "requires": {
      "odatano-core": {
        "network": "preprod",
        "backends": ["blockfrost"],
        "blockfrostApiKey": "preprodXXXXXXXXXXXXXXXXX"
      }
    }
  }
}
```

That's it — `cds watch` and every request to a gated route gets:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json
```
```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "cardano:preprod",
    "asset": "lovelace",
    "amount": "500000",
    "payTo": "addr_test1...",
    "resource": {
      "url": "/odata/v4/prices/Quotes",
      "description": "Synthetic price feed",
      "mimeType": "application/json"
    },
    "assetTransferMethod": "default",
    "maxTimeoutSeconds": 600
  }]
}
```

A working version of this is in [`examples/cap-app/`](examples/cap-app/).

---

## Usage patterns

### 1. CAP service gate (`gateService`)

For OData-served entities and bound/unbound actions. Pricing keys can be entity names (for CRUD) or action names — the gate tries both.

```typescript
gateService(this, {
  payTo, network, asset,
  routePricing: { Quotes: '500000', getBestPrice: '1000000' },
});
```

When a payment is accepted, the verified `PaymentClaim` is stashed on `req.payment` for downstream handlers, and an `X-PAYMENT-RESPONSE` header is set on the response.

### 2. Express middleware (`x402Middleware`)

For plain Express routes (e.g. mounted alongside CAP via `cds.on('bootstrap', app => …)`):

```typescript
import { x402Middleware } from '@odatano/x402';

app.use('/api/premium', x402Middleware({
  payTo, network, asset,
  priceUnits: '1000000',
  skipPaths: /(\$metadata|^\/?$)/i,
  onAccepted: async (claim, req) => { /* audit */ },
}));
```

### 3. Programmatic — verify a post-paid tx

For subscription / pre-paid flows where the buyer hands you a tx hash:

```typescript
import { verifyConfirmedPayment } from '@odatano/x402';

const result = await verifyConfirmedPayment({
  txHash:         'ab8f…',
  requiredAmount: '1000000',
  asset:          'lovelace',
  payTo:          'addr_test1...',
  network:        'cardano:preprod',
});

if (result.ok) {
  // result.amountUnits is what was actually paid (may exceed requiredAmount)
} else {
  // result.code: 'pending' | 'wrong_asset' | 'insufficient_amount' | ...
}
```

### 4. Programmatic — server-side unsigned-tx builder for browser buyers

When the buyer's CIP-30 wallet can sign but not coin-select:

```typescript
import { buildUnsignedPaymentTx, buildPaymentRequirements, flatRequirements } from '@odatano/x402';

const body = buildPaymentRequirements({ amount: '1000000', asset: 'lovelace', payTo, network: 'cardano:preprod', resource: '/r' });
const requirements = flatRequirements(body);

const { unsignedTxCborHex, txHashHex, nonceRef } = await buildUnsignedPaymentTx({
  buyerBech32: 'addr_test1...buyer...',
  requirements,
});

// Browser signs unsignedTxCborHex via CIP-30, then assembles the
// PAYMENT-SIGNATURE envelope with `nonceRef` as payload.nonce.
```

---

## Configuration reference

### `gateService(srv, options)` / `x402Middleware(options)`

| Option | Type | Required | Default | Notes |
|---|---|---|---|---|
| `payTo` | `string` (bech32) | yes | — | Recipient address |
| `network` | `'cardano:mainnet' \| 'cardano:preprod' \| 'cardano:preview'` | yes | — | **v2 uses colon separator** (v1 hyphen rejected) |
| `asset` | `string` | yes | — | `'lovelace'` for ADA, or `'<policyIdHex>.<assetNameHex>'` for native tokens |
| `priceUnits` | `string \| number \| bigint` | one of priceUnits / routePricing | — | Single price for everything under the mount |
| `routePricing` | `Record<string, string \| number \| bigint>` | one of priceUnits / routePricing | — | Per-entity / per-action prices. Unmapped keys pass through unless `priceUnits` is also set |
| `skipPaths` | `RegExp` | no | matches `$metadata`, `$batch`, root, `/index` | Express only — paths to bypass |
| `description` | `string` | no | `''` | Embedded in `accepts[0].resource.description` |
| `mimeType` | `string` | no | `'application/json'` | Embedded in `accepts[0].resource.mimeType` |
| `assetTransferMethod` | `'default' \| 'masumi' \| 'script'` | no | `'default'` | v2 field; MVP supports only `default` |
| `maxTimeoutSeconds` | `number` | no | `600` | Buyer-side TTL hint |
| `extra` | `Record<string, unknown>` | no | — | Free-form extras (decimals, fingerprint, UI hints) |
| `settlePollBudgetMs` | `number` | no | `60_000` | How long to poll for chain confirmation before returning `402 pending` |
| `allowNoTtl` | `boolean` | no | `false` | If `true`, accept txs with no validity-range upper bound |
| `onAccepted` | `(claim, req) => void \| Promise<void>` | no | — | Audit callback. Errors logged, never block response |
| `resourceUrl` | `(req) => string` | no (CAP only) | derives from `req.http.req.originalUrl` | Override the resource URL emitted in the 402 body |

---

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

`PAYMENT-SIGNATURE` envelope shape:

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

The `nonce` references a UTxO that **must also appear as an input of the payment tx**. Once the tx settles, that UTxO is consumed — replay defense is on-chain, no DB table needed.

---

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

---

## Architecture

```
            ┌──────────────────┐
  consumer  │ CAP application  │
            │                  │
            │ gateService(this,│
            │   { … })         │
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐    bridge.ts
            │  @odatano/x402   │ ──────────────┐
            │                  │               │
            │ core/      ──────┤ pure logic    │
            │ facilitator/ ────┤ chain-touching│
            │ middleware/  ────┤ Express + CAP │
            │ helpers/     ────┤ tx-build,     │
            │                  │ verify-post-paid
            └──────────────────┘               │
                                               ▼
                                  ┌────────────────────────┐
                                  │   @odatano/core 1.7.8  │
                                  │  ┌──────┬──────┬─────┐ │
                                  │  │ Blkf │Koios │Ogms │ │
                                  │  └──────┴──────┴─────┘ │
                                  └────────────────────────┘
                                            │
                                            ▼
                                       Cardano network
```

Pure modules (`core/*`) are decoupled from the bridge and can be unit-tested without any chain backend. The facilitator orchestrates `decode → validate → checkNonceUnspent → settle → onAccepted`.

---

## Requirements

- Node.js 22+
- `@sap/cds >= 9` (peer)
- `@odatano/core >= 1.7.8` (peer)
- `express ^4` (peer) — only required if you use `x402Middleware`
- A Cardano backend reachable via `@odatano/core` (Blockfrost / Koios / Ogmios)

---

## Development

```bash
npm install                # Workspace install — covers root + examples/*
npm run build              # tsc — emits .js/.d.ts next to .ts (outDir: .)
npm test                   # 144 tests, ~12s
npm run test:coverage      # Coverage report
npm run watch              # cds watch — for the root project itself
```

The example app:

```bash
cd examples/cap-app
npm start                  # cds-serve with in-memory SQLite
```

Then probe:

```bash
curl -s http://localhost:4004/odata/v4/prices/Quotes | jq .
# → 402 with v2 body
```

---

## Versioning + spec compatibility

- **Library:** `0.1.0` (pre-1.0; expect minor breakages between minors until 1.0)
- **Spec:** Cardano-x402-**v2** only. v1 envelopes are rejected with `unsupported_version`. v1-style network strings (`cardano-preprod`) are rejected with `invalid_network_format`.
- **Coexistence:** A v1 facilitator and a v2 facilitator can't share the same route — they use different header names (`X-PAYMENT` vs `PAYMENT-SIGNATURE`) and incompatible 402 bodies. To migrate from v1, replace the middleware in one commit; clients must upgrade simultaneously.

---

## License

Apache-2.0.
