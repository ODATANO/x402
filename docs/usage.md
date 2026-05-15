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

### Client-side errors (`X402PaymentError`)

Both wrappers throw an `X402PaymentError` when payment cannot complete. Catch it to distinguish wallet-cancel from chain-rejection:

```typescript
import { x402Fetch, X402PaymentError } from '@odatano/x402';

const paidFetch = x402Fetch({
  pay: myCip30PayHandler,
  errorOnFailure: true, // throw on unrecovered 402 instead of returning it
});

try {
  const res = await paidFetch('https://api.example.com/Quotes');
} catch (err) {
  if (err instanceof X402PaymentError) {
    switch (err.kind) {
      case 'pay_handler_failed':   /* wallet rejection, err.cause = original */ break;
      case 'server_rejected':       /* server returned 402; err.code = canonical code */ break;
      case 'retries_exhausted':     /* tried maxRetries times, still 402 */ break;
      case 'invalid_402_body':      /* server replied 402 but body was malformed */ break;
    }
    console.log(err.code, err.serverError, err.accepts);
  }
}
```

Shape:

| Field        | Type                        | Notes |
|--------------|-----------------------------|-------|
| `kind`       | `X402PaymentErrorKind`      | discriminator (see above) |
| `code`       | `string?`                   | canonical `X402Code` parsed from `serverError` when present |
| `accepts`    | `PaymentRequirementEntry[]?`| `accepts[]` from the 402 body so callers can retry against a different option |
| `httpStatus` | `number?`                   | usually `402` |
| `serverError`| `string?`                   | raw `error` field of the 402 body |
| `cause`      | `unknown?`                  | original wallet / signer / axios error when wrapped |

**`errorOnFailure: true`** (default `false`) switches behaviour on unrecovered 402:

- `x402Fetch`: throws `X402PaymentError(retries_exhausted)` instead of returning the last `Response`.
- `x402Axios`: throws `X402PaymentError(retries_exhausted)` instead of re-throwing the original AxiosError.

**Pay-handler errors are ALWAYS wrapped** in `X402PaymentError(pay_handler_failed)` regardless of `errorOnFailure`, with the original error preserved on `.cause`.

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
| `priceUnits` | `PriceSpec` | one of priceUnits / routePricing | - | Single price (scalar, `RouteOption`, or `RouteOption[]` for multi-accept) for everything under the mount |
| `routePricing` | `Record<string, PriceSpec> \| PriceResolver` | one of priceUnits / routePricing | - | Per-entity / per-action prices, OR a dynamic resolver `(ctx) => PriceSpec \| null`. Resolver returning `null` skips the gate. Static-map unmapped keys fall back to `priceUnits` |
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
| `receipts` | `boolean \| { entity?: string }` | no (CAP only) | `false` | Persist accepted payments to a CDS entity. `true` uses the shipped `odatano.x402.X402Receipts`; pass `{ entity }` for a custom table |
| `grants` | `boolean \| { ttlSeconds?: number; entity?: string }` | no (CAP only) | `false` | Issue time-limited access grants on accepted payment. Buyer's `X-PAYMENT-GRANT` header bypasses the gate until expiry. Default TTL 3600s, default entity `odatano.x402.X402Grants` |

### `PriceSpec` and `PriceResolver`

```typescript
type PriceSpec =
  | string | number | bigint   // shorthand: single price in the default asset
  | RouteOption                // single price with per-option overrides
  | RouteOption[];             // multi-accept; buyer picks one implicitly on-chain

interface RouteOption {
  amount: string | number | bigint;
  asset?: string;              // override the top-level default asset
  payTo?: string;              // override the top-level recipient
  network?: Network | string;
  description?: string;
  mimeType?: string;
  assetTransferMethod?: AssetTransferMethod;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

type PriceResolver = (ctx: PricingContext) => PriceSpec | null | Promise<PriceSpec | null>;

interface PricingContext {
  event: string;              // CAP event ('READ' | 'CREATE' | action) OR Express URL last segment
  target?: string;            // CAP only: 'PricesService.Quotes'
  path?: string;              // Express only
  method?: string;            // Express only
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}
```

#### Multi-accept example , "0.5 ADA *or* 0.1 USDM"

```typescript
gateService(this, {
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  routePricing: {
    Quotes: [
      { amount: '500000' },                                              // 0.5 ADA
      { amount: '100000', asset: '16a55b…ddde.0014df105553444d' },       // 0.1 USDM
    ],
  },
});
```

The buyer picks one implicitly by which `(payTo, asset)` the payment tx
actually credits; the facilitator's `pickRequirement()` selects the
matching entry before running the strict per-entry checks.

#### Dynamic-pricing example , free tier + per-role price

```typescript
x402Middleware({
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  routePricing: async (ctx) => {
    if (ctx.headers['x-api-key'] === process.env.INTERNAL_KEY) return null;     // bypass
    const tier = String(ctx.headers['x-tier'] ?? 'free');
    if (tier === 'free')      return null;
    if (tier === 'gold')      return '500000';
    if (tier === 'platinum')  return '100000';
    return '1000000';
  },
});
```

Returning `null` skips the gate (free tier or internal allowlist).
Throwing surfaces as `500` to the buyer.

#### Receipts persistence (`receipts`)

`gateService` can write one row per accepted payment to a CDS entity.
The plugin ships the canonical entity in `db/x402-receipts.cds`, CAP
auto-discovers it when `@odatano/x402` is in `node_modules`.

```typescript
gateService(this, {
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  priceUnits: '1000000',
  receipts: true, // → writes to odatano.x402.X402Receipts
});
```

Default entity shape (`odatano.x402.X402Receipts`):

| Field      | Type        | Notes |
|------------|-------------|-------|
| `ID`       | `UUID`      | primary key |
| `txHash`   | `String(64)`| lowercase hex, `@assert.unique` |
| `payerAddr`| `String(120)`| nullable; populated if the facilitator resolved it |
| `payTo`    | `String(120)`| bech32 recipient |
| `asset`    | `String(120)`| `'lovelace'` or `'<policy>.<nameHex>'` |
| `amount`   | `String(32)` | raw units, BigInt-safe |
| `network`  | `String(20)` | `cardano:preprod` etc. |
| `route`    | `String(500)`| request URL or `cap://<event>` |
| `nonceRef` | `String(80)` | `<txHash>#<index>` of the consumed UTxO |
| `at`       | `Timestamp`  | server-side timestamp |

The INSERT runs after settle confirms, before the 200 response. INSERT
failures are logged and SWALLOWED, the canonical record is on chain.
Pair with `onAccepted` if you need side-effects beyond persistence:
receipts run first, your `onAccepted` runs second.

**Custom table:** pass `receipts: { entity: 'my.ns.MyTable' }`. Your
table must carry the columns above (CDS-typed; CAP handles SQL mapping).

**Express:** receipts are CAP-only. Express users who want persistence
should write their own `onAccepted` handler against their ORM of choice.

#### Subscription / time-limited grants (`grants`)

Pay once, get N seconds of free access to the same route. On accepted
payment the gate writes a grant row and returns the token via
`X-PAYMENT-GRANT` / `X-PAYMENT-GRANT-EXPIRES` response headers. On
subsequent calls the buyer presents `X-PAYMENT-GRANT` as a request header;
while the token is valid + route-matching, the gate bypasses the 402 +
verify+settle pipeline entirely.

```typescript
gateService(this, {
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  priceUnits: '1000000',
  grants: { ttlSeconds: 3600 }, // → 1h subscription per paid route
});
```

Client flow:

```text
1.  GET /Quotes
    → 402 + accepts[0]
2.  GET /Quotes  PAYMENT-SIGNATURE: <envelope>
    → 200 + X-PAYMENT-GRANT: <token>  X-PAYMENT-GRANT-EXPIRES: <ISO>
3.  GET /Quotes  X-PAYMENT-GRANT: <token>      ← bypass; no chain calls
    → 200
4.  (after expiry)
    GET /Quotes  X-PAYMENT-GRANT: <expired>
    → 402   ← grant ignored, normal flow resumes
```

Default entity shape (`odatano.x402.X402Grants`): `{ id, token (uniq), route, payerAddr?, txHash, asset, network, issuedAt, expiresAt }`.

Notes:
- Grants are **single-route**. A grant for `/Quotes` does NOT unlock `/getBestPrice`. The route check is strict equality against the resource URL the 402 advertised.
- Token format: random 32 bytes, base64url-encoded. Opaque; the server owns the truth via DB lookup. Revocation is a single `DELETE`.
- Expired rows accumulate. The library does NOT auto-prune; run a `DELETE FROM X402Grants WHERE expiresAt < now()` on your own schedule.
- DB failures during issue or lookup are SWALLOWED. A failing DB never denies a paying buyer their response; the worst case is buyers re-pay until the DB recovers.
- **Express:** grants are CAP-only for now (depends on the CDS DB layer). Express users with subscription needs can implement an equivalent `onAccepted` + custom store.
