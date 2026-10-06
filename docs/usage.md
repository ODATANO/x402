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
      // Lovelace prices must clear Cardano's min-UTxO (~0.98 ADA on
      // current params); 1 ADA is the practical floor.
      routePricing: { Quotes: '1000000', getBestPrice: '2000000' },
      onAccepted: async (claim, req) => {
        console.log(`paid ${claim.amountUnits} ${claim.asset} (tx=${claim.txHash})`);
      },
    });
    return super.init();
  }
}
```

The gate verifies the payment before your handler runs and stashes the verified `PaymentClaim` on `req.payment`. After the handler's transaction committed it settles; the response carries a `PAYMENT-RESPONSE` header. A handler error is never settled. A failed or pending settlement turns the response into a 402; what the handler wrote stays committed, and the buyer's retry runs the handler again, so gated handlers should be safe to repeat. Register the gate before handlers that use the database: on a single-connection database (SQLite) the gate's own records need the connection free.

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

Not part of x402: for subscription or pre-paid flows where the buyer
submitted a payment on its own and hands you the tx hash. Replay
protection is your job here (e.g. redeem each hash once).

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
  // result.code: a reason code from `Codes`, e.g. Codes.INSUFFICIENT_AMOUNT
}
```

## 4. Programmatic: server-side unsigned-tx builder for browser buyers

When the buyer's CIP-30 wallet can sign but not coin-select:

```typescript
import { buildUnsignedPaymentTx, encodePaymentPayload } from '@odatano/x402';

// `requirement` is the accepts[] entry the browser chose from PAYMENT-REQUIRED.
const { unsignedTxCborHex, nonceRef } = await buildUnsignedPaymentTx({
  buyerBech32: 'addr_test1...buyer...',
  requirements: requirement,
});

// The browser signs unsignedTxCborHex via CIP-30 and sends
// encodePaymentPayload({ paymentRequired, accepted: requirement, signedTxCborHex, nonceRef })
// as PAYMENT-SIGNATURE.
```

The TTL stays within `maxTimeoutSeconds`. A lovelace amount below the
output's min-UTxO is refused (the amount is the output coin); a native
asset output gets its min-ADA added by `@odatano/core`.

## 5. Client-side: auto-handle 402 (`x402Fetch` / `x402Axios`)

For *callers* of an x402-gated API. On a 402 the wrapper reads `PAYMENT-REQUIRED`, picks an `accepts[]` entry, runs your `pay` handler, and retries with `PAYMENT-SIGNATURE`. A 402 whose `PAYMENT-RESPONSE` says `settlement_pending` is answered by re-sending the same header (never by paying again). Your call-site stays one line.

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

The `PayHandler` is the one extension point: `(requirement, paymentRequired) => { signedTxCborHex, nonceRef }`. Write your own for browser CIP-30 wallets, hardware wallets or external signers. `createBridgePayHandler` is the default for Node and server-to-server flows, using `buildUnsignedPaymentTx`. The default `selectAccepts` takes the first entry with a supported transfer method (`default`, `script`) and the `authorization` payment flow.

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
      case 'server_rejected':          /* server returned 402; err.code = reason code */ break;
      case 'retries_exhausted':        /* tried maxRetries times, still 402 */ break;
      case 'invalid_payment_required': /* 402 without a valid PAYMENT-REQUIRED header */ break;
      case 'settlement_pending':       /* paid, not confirmed in time: retry later, do not pay again */ break;
    }
    console.log(err.code, err.serverError, err.accepts);
  }
}
```

Shape:

| Field        | Type                        | Notes |
|--------------|-----------------------------|-------|
| `kind`       | `X402PaymentErrorKind`      | discriminator (see above) |
| `code`       | `string?`                   | reason code: `PAYMENT-RESPONSE.errorReason`, else parsed from `serverError` |
| `accepts`    | `PaymentRequirements[]?`    | `accepts[]` of the 402, to retry against a different option |
| `settlement` | `SettlementResponse?`       | `PAYMENT-RESPONSE` of a failed or pending settlement |
| `httpStatus` | `number?`                   | usually `402` |
| `serverError`| `string?`                   | `PaymentRequired.error` |
| `cause`      | `unknown?`                  | original wallet / signer / axios error when wrapped |

**`errorOnFailure: true`** (default `false`) switches behaviour on unrecovered 402:

- `x402Fetch`: throws `X402PaymentError(retries_exhausted)` instead of returning the last `Response`.
- `x402Axios`: throws `X402PaymentError(retries_exhausted)` instead of re-throwing the original AxiosError.

**Pay-handler errors are ALWAYS wrapped** in `X402PaymentError(pay_handler_failed)` regardless of `errorOnFailure`, with the original error preserved on `.cause`.

## Facilitator: local vs hosted

Verify and settle touch the chain. By default they run **in-process** via `localFacilitator()`, so the resource server needs `@odatano/core` configured against a Cardano backend.

A **hosted facilitator** serves many resource servers over HTTP with the x402 v2 facilitator API (`POST /verify`, `POST /settle`, `GET /supported`). `httpFacilitator()` talks to any conformant one, `createFacilitatorRouter()` serves one. The resource server then needs `@odatano/core` installed for decoding, but no Cardano backend.

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

See [`facilitator-protocol.md`](facilitator-protocol.md) for the API and serving one. The `Facilitator` interface also lets you swap in a mock for deterministic tests:

```typescript
const mock: Facilitator = {
  verify: async () => ({ isValid: true, payer: 'addr_test1...' }),
  settle: async (_payload, req) => ({ success: true, transaction: 'ab...', network: req.network }),
};
gateService(this, { ...opts, facilitator: mock });
```

A facilitator holds the settlement claims that prevent a payment from being delivered twice. Gates without a `facilitator` option share one per process (`defaultFacilitator()`); if you create your own with `localFacilitator()`, create it once and pass it to every gate. Several instances serving the same payees share the claims through `localFacilitator({ store: cdsSettlementStore() })` or the `settlements: true` option of `gateService`.

---

## Configuration reference

### `gateService(srv, options)` / `x402Middleware(options)`

| Option | Type | Required | Default | Notes |
|---|---|---|---|---|
| `payTo` | `string` (bech32) | yes | - | Recipient address |
| `network` | `'cardano:mainnet' \| 'cardano:preprod' \| 'cardano:preview'` | yes | - | CIP-34 forms (`cip34:0-1`, ...) are accepted and normalized |
| `asset` | `string` | yes | - | `'lovelace'` for ADA, or `'<policyIdHex>.<assetNameHex>'` for native tokens |
| `priceUnits` | `PriceSpec` | one of priceUnits / routePricing | - | Single price (scalar, `RouteOption`, or `RouteOption[]` for multi-accept) for everything under the mount |
| `routePricing` | `Record<string, PriceSpec> \| PriceResolver` | one of priceUnits / routePricing | - | Per-entity / per-action prices, OR a dynamic resolver `(ctx) => PriceSpec \| null`. Resolver returning `null` skips the gate. Static-map unmapped keys fall back to `priceUnits`. A resolver must return the same requirements on the paid retry |
| `skipPaths` | `RegExp` | no | matches `$metadata`, `$batch`, root, `/index` | Express only. Paths to bypass |
| `description`, `mimeType`, `serviceName`, `tags`, `iconUrl` | `ResourceInfo` fields | no | `mimeType` `'application/json'` | Describe the route in `PaymentRequired.resource` |
| `maxTimeoutSeconds` | `number` | no | `600` | Upper bound of the payment tx's TTL |
| `extra` | `PaymentExtra` | no | - | `assetTransferMethod` (absent = `'default'`) plus free-form extras. See [Script transfers](#script-transfers-escrow-locks) |
| `confirmationPolicy` | `{ l1Confirmations: number }` | no | `{ l1Confirmations: 1 }` | Chain evidence settle waits for: -1 broadcast (facilitator opt-in), 0 in a block, n newer blocks |
| `extensions` | `Record<string, unknown>` | no | - | `PaymentRequired.extensions`, echoed by buyers |
| `onAccepted` | `(claim, req) => void \| Promise<void>` | no | - | Audit callback after settlement. Errors logged, never block the response |
| `verifyTransfer` | `(ctx) => { ok: true } \| { ok: false; reason }` (sync or async) | no | - | Own check on the verified payment tx before the handler runs, e.g. the inline datum of a script lock. Rejection → `402 transfer_rejected`; a throw → `500` |
| `resourceUrl` | `(req) => string` | no (CAP only) | derives from `req.http.req.originalUrl` | Override `PaymentRequired.resource.url` |
| `facilitator` | `Facilitator` | no | process-wide `defaultFacilitator()` | Pluggable verify and settle. `httpFacilitator({ url, apiKey })` for a hosted one, or a mock |
| `settlements` | `boolean \| { entity?: string }` | no (CAP only) | `false` | Keep settlement claims in `odatano.x402.X402Settlements` (or `{ entity }`) so several instances share them. Default facilitator only |
| `receipts` | `boolean \| { entity?: string }` | no (CAP only) | `false` | Persist settled payments. `true` uses the shipped `odatano.x402.X402Receipts`; pass `{ entity }` for a custom table |
| `grants` | `boolean \| { ttlSeconds?: number; entity?: string }` | no (CAP only) | `false` | Server policy, not x402: after a settled payment, the buyer's `X-PAYMENT-GRANT` token skips payment for the route until expiry. Default TTL 3600s, entity `odatano.x402.X402Grants` |

### `PriceSpec` and `PriceResolver`

```typescript
type PriceSpec =
  | string | number | bigint   // shorthand: single price in the default asset
  | RouteOption                // single price with per-option overrides
  | RouteOption[];             // multi-accept; the buyer names its choice in `accepted`

interface RouteOption {
  amount: string | number | bigint;
  asset?: string;              // override the top-level default asset
  payTo?: string;              // override the top-level recipient
  network?: Network | string;
  maxTimeoutSeconds?: number;
  extra?: PaymentExtra;        // replaces the top-level extra, not merged
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

#### Multi-accept example , "1 ADA *or* 0.1 USDM"

```typescript
gateService(this, {
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  routePricing: {
    Quotes: [
      { amount: '1000000' },                                             // 1 ADA
      { amount: '100000', asset: '16a55b…ddde.0014df105553444d' },       // 0.1 USDM
    ],
  },
});
```

Native-asset prices (like the USDM entry) can be arbitrarily small, the
payment output carries its own min-ADA on top. Lovelace prices below
Cardano's min-UTxO (~0.98 ADA) are unpayable: the amount is the output
coin, and clients refuse to build an output the ledger would reject.

The buyer names the entry it pays in `PaymentPayload.accepted`; the
server matches it exactly against the offered entries.

#### Dynamic-pricing example , free tier + per-role price

```typescript
x402Middleware({
  payTo, network: 'cardano:preprod', asset: 'lovelace',
  routePricing: async (ctx) => {
    if (ctx.headers['x-api-key'] === process.env.INTERNAL_KEY) return null;     // bypass
    const tier = String(ctx.headers['x-tier'] ?? 'free');
    if (tier === 'free')      return null;
    if (tier === 'gold')      return '1500000';
    if (tier === 'platinum')  return '1000000';
    return '2000000';
  },
});
```

Returning `null` skips the gate (free tier or internal allowlist).
Throwing surfaces as `500` to the buyer.

#### Script transfers (escrow locks)

With `extra.assetTransferMethod: 'script'` the buyer locks the payment at
a script address instead of paying `payTo` directly. `payTo` is that
script's address. `extra.datum` (CBOR hex) is the inline datum the buyer
attaches to the locked output. The payment is settled once the lock is on
chain. Spending it later is your contract's business, not x402's.

```typescript
gateService(this, {
  payTo:   escrowAddress,              // address of the script below
  network: 'cardano:preprod',
  asset:   'lovelace',
  // The datum differs per request, so the paid retry is matched against
  // what the 402 offered instead of being priced again.
  issuedRequirements: memoryIssuedRequirementsStore(),
  routePricing: async (ctx) => ({
    amount: '5000000',
    extra: {
      assetTransferMethod: 'script',
      scriptHash: ESCROW_SCRIPT_HASH,  // 56 hex, must match payTo
      datum:      await orderDatumFor(ctx),
    },
  }),
  verifyTransfer: ({ decoded, requirement }) => {
    const lock = decoded.outputs.find(o => o.address === requirement.payTo);
    return lock?.inlineDatumHex && isMyOrderDatum(lock.inlineDatumHex)
      ? { ok: true }
      : { ok: false, reason: 'lock does not carry the order datum' };
  },
});
```

Instead of `scriptHash` you can declare the script itself:
`script: { type: 'plutusV3', code }` plus optional `parameters`. The hash
is then derived from the code with the parameters applied in key order.
Parameter types are `bytes` (hex), `string` (UTF-8), `integer` /
`bigint` and `boolean`, each applied as PlutusData. If both `script` and
`scriptHash` are given they must agree. Plutus V2 and V3 only.

The facilitator checks on top of the verification rules:

- `payTo` is the address of the declared script → else `script_address_mismatch`.
- `extra.datum` set → an output to `payTo` carries an inline datum → else `datum_missing`.
- that datum equals `extra.datum` as PlutusData → else `datum_mismatch`.
  The encoding may differ, a client may re-encode the datum when attaching it.

Whether the datum suits your contract is not checked: only your contract
knows. A wrong datum can strand the buyer's funds. `verifyTransfer` is
the place for anything beyond "the lock carries `extra.datum`".
`buildRequirements` refuses a `script` extra whose script does not match
`payTo`, or whose `datum` is not CBOR PlutusData. The accepted claim
carries `extra.lockRefs`, the `<txHash>#<index>` of every locked output.

On the buyer side, the default `selectAccepts` takes the first entry with
method `default` or `script`. `buildUnsignedPaymentTx` and
`createBridgePayHandler` build the lock: they check the entry like the
facilitator does, write `extra.datum` byte for byte as the inline datum,
and add min-ADA for native-asset outputs; a lovelace amount must clear
the output's min-UTxO itself, which a datum raises.

Requirements that differ per request need `issuedRequirements`: the
buyer's `accepted` is matched exactly, so without the store a fresh
datum on the paid retry would not match. The in-process store suits a
single instance; several instances need a shared implementation of
`IssuedRequirementsStore`.

#### Receipts persistence (`receipts`)

`gateService` can write one row per settled payment to a CDS entity.
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
| `txHash`   | `String(64)`| lowercase hex, unique |
| `payerAddr`| `String(120)`| nullable; the nonce UTxO's address (the buyer's own input), resolved by the facilitator since 0.5.2, null when the backend could not read it |
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
    → 402 + PAYMENT-REQUIRED
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
