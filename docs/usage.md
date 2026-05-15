# Usage patterns + configuration reference

Five ways to use `@odatano/x402`, ranging from a CAP service gate to a fetch wrapper for *callers* of a gated API. The configuration reference at the bottom applies to both `gateService` and `x402Middleware`.

## 1. CAP service gate (`gateService`)

For OData-served entities and bound/unbound actions. Pricing keys can be entity names (for CRUD) or action names; the gate tries both.

```typescript
import cds from '@sap/cds';
import { gateService } from '@odatano/x402';

export class PricesService extends cds.ApplicationService {
  async init() {
    gateService(this, {
      payTo:   'addr_test1...',
      network: 'cardano:preprod',
      asset:   'lovelace',
      routePricing: { Quotes: '500000', getBestPrice: '1000000' },
      onAccepted: async (claim, req) => {
        console.log(`paid ${claim.amountUnits} ${claim.asset} (tx=${claim.txHash})`);
      },
    });
    return super.init();
  }
}
```

When a payment is accepted, the verified `PaymentClaim` is stashed on `req.payment` for downstream handlers, and an `X-PAYMENT-RESPONSE` header is set on the response.

## 2. Express middleware (`x402Middleware`)

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

## 3. Programmatic: verify a post-paid tx

For subscription or pre-paid flows where the buyer hands you a tx hash:

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

## 4. Programmatic: server-side unsigned-tx builder for browser buyers

When the buyer's CIP-30 wallet can sign but not coin-select:

```typescript
import { buildUnsignedPaymentTx, buildPaymentRequirements, flatRequirements } from '@odatano/x402';

const body = buildPaymentRequirements({
  amount: '1000000', asset: 'lovelace',
  payTo, network: 'cardano:preprod',
  resource: { url: '/r', description: '', mimeType: 'application/json' },
});
const requirements = flatRequirements(body);

const { unsignedTxCborHex, txHashHex, nonceRef } = await buildUnsignedPaymentTx({
  buyerBech32: 'addr_test1...buyer...',
  requirements,
});

// Browser signs unsignedTxCborHex via CIP-30, then assembles the
// PAYMENT-SIGNATURE envelope with `nonceRef` as payload.nonce.
```

## 5. Client-side: auto-handle 402 (`x402Fetch` / `x402Axios`)

For *callers* of an x402-gated API. The wrapper detects the 402, runs your `pay` handler, and retries the request with a valid `PAYMENT-SIGNATURE` header. Your call-site stays one line.

```typescript
import { x402Fetch, createBridgePayHandler } from '@odatano/x402';

const paidFetch = x402Fetch({
  pay: createBridgePayHandler({
    buyerBech32: 'addr_test1...buyer...',
    signTx:      async (unsignedCbor) => { /* sign with key / CIP-30 / hardware wallet */ return signedCbor; },
  }),
});

const res = await paidFetch('https://api.example.com/odata/v4/prices/Quotes');
// → 200, payment settled on-chain transparently
```

Axios variant, interceptor pattern, same `pay` contract:

```typescript
import axios from 'axios';
import { x402Axios, createBridgePayHandler } from '@odatano/x402';

const client = x402Axios(axios.create({ baseURL: '...' }), {
  pay: createBridgePayHandler({ buyerBech32, signTx }),
});
await client.get('/odata/v4/prices/Quotes');
```

The `PayHandler` is the one extension point. Write your own to plug in browser CIP-30 wallets, hardware wallets, or external signers. `createBridgePayHandler` is the default for Node and server-to-server flows, leveraging `buildUnsignedPaymentTx` under the hood.

## Facilitator: local vs hosted

Verify+settle is the chain-touching workhorse of x402. By default it runs **in-process** in the same Node that serves your CAP/Express app, via `localFacilitator()`. That means each resource server needs `@odatano/core` configured against a Cardano backend.

For multi-tenant deployments, you can split this out: a single **hosted facilitator** serves many resource servers over HTTP. The resource servers don't carry `@odatano/core` at all; they delegate verify+settle via `httpFacilitator()`.

```typescript
// Resource server: no Cardano backend needed locally.
import { x402Middleware, httpFacilitator } from '@odatano/x402';

app.use('/api/premium', x402Middleware({
  payTo, network, asset, priceUnits,
  facilitator: httpFacilitator({
    url:    'https://facilitator.example/v1',
    apiKey: process.env.FACILITATOR_API_KEY,
  }),
}));
```

See [`facilitator-protocol.md`](facilitator-protocol.md) for the full HTTP wire format and a reference Express implementation. The same `Facilitator` interface lets you swap in a mock for deterministic tests:

```typescript
const mock: Facilitator = {
  verifyAndSettle: async () => ({ kind: 'accepted', txHash: 'a...', payment, paymentResponseB64: '...' }),
};
gateService(this, { ...opts, facilitator: mock });
```

---

## Configuration reference

### `gateService(srv, options)` / `x402Middleware(options)`

| Option | Type | Required | Default | Notes |
|---|---|---|---|---|
| `payTo` | `string` (bech32) | yes | - | Recipient address |
| `network` | `'cardano:mainnet' \| 'cardano:preprod' \| 'cardano:preview'` | yes | - | **v2 uses colon separator** (v1 hyphen rejected) |
| `asset` | `string` | yes | - | `'lovelace'` for ADA, or `'<policyIdHex>.<assetNameHex>'` for native tokens |
| `priceUnits` | `string \| number \| bigint` | one of priceUnits / routePricing | - | Single price for everything under the mount |
| `routePricing` | `Record<string, string \| number \| bigint>` | one of priceUnits / routePricing | - | Per-entity / per-action prices. Unmapped keys pass through unless `priceUnits` is also set |
| `skipPaths` | `RegExp` | no | matches `$metadata`, `$batch`, root, `/index` | Express only. Paths to bypass |
| `description` | `string` | no | `''` | Embedded in `accepts[0].resource.description` |
| `mimeType` | `string` | no | `'application/json'` | Embedded in `accepts[0].resource.mimeType` |
| `assetTransferMethod` | `'default' \| 'masumi' \| 'script'` | no | `'default'` | v2 field; MVP supports only `default` |
| `maxTimeoutSeconds` | `number` | no | `600` | Buyer-side TTL hint |
| `extra` | `Record<string, unknown>` | no | - | Free-form extras (decimals, fingerprint, UI hints) |
| `settlePollBudgetMs` | `number` | no | `60_000` | How long to poll for chain confirmation before returning `402 pending` |
| `allowNoTtl` | `boolean` | no | `false` | If `true`, accept txs with no validity-range upper bound |
| `onAccepted` | `(claim, req) => void \| Promise<void>` | no | - | Audit callback. Errors logged, never block response |
| `resourceUrl` | `(req) => string` | no (CAP only) | derives from `req.http.req.originalUrl` | Override the resource URL emitted in the 402 body |
| `facilitator` | `Facilitator` | no | `localFacilitator()` | Pluggable verify+settle. Pass `httpFacilitator({ url, apiKey })` for hosted, or any custom impl for mocks |
