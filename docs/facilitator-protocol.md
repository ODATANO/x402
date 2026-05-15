# Facilitator Protocol: `@odatano/x402` HTTP Wire Format

This document specifies the HTTP contract between a resource server using
`@odatano/x402` and a **hosted facilitator** that handles verification
and settlement.

Resource servers wire a hosted facilitator via `httpFacilitator()`:

```typescript
import { x402Middleware, httpFacilitator } from '@odatano/x402';

app.use('/api/premium', x402Middleware({
  payTo, network, asset, priceUnits,
  facilitator: httpFacilitator({
    url:    'https://facilitator.example/v1',
    apiKey: process.env.FACILITATOR_API_KEY,
  }),
}));
```

Any service that conforms to the spec below can serve as the
`facilitator` endpoint: Coinbase-style hosted, self-hosted in a
sibling deployment, or a mock for testing.

---

## Base URL

All endpoints are relative to the `url` configured on the client. The
client trims a trailing slash before joining, so both forms work:

- `https://facilitator.example`
- `https://facilitator.example/v1/`

---

## Authentication

If `apiKey` is set on the client, every request carries:

```
Authorization: Bearer <apiKey>
```

For custom schemes (mTLS, OAuth, signed-request), pass a `headers()`
builder on the client; the returned object is merged on top of the
defaults (your values win for any colliding header name).

---

## Endpoints

### `POST /verify-settle`

The single operation a facilitator MUST implement. Runs the full
1.decode → 2.validate → 3.nonce → 4.settle pipeline.

#### Request

```http
POST /verify-settle HTTP/1.1
Content-Type: application/json
Authorization: Bearer <apiKey>
```

```jsonc
{
  "paymentHeader":     "<base64 PAYMENT-SIGNATURE envelope>",
  "requirementsBody": {
    "x402Version": 2,
    "accepts": [ /* PaymentRequirementEntry; only accepts[0] is used */ ]
  },
  "settlePollBudgetMs": 60000,   // optional, default 60000
  "allowNoTtl":         false    // optional, default false
}
```

Note: `onAccepted` is intentionally not transmitted. The
`httpFacilitator` client invokes it locally after the response.

#### Response: `200 OK`

One of three discriminated `kind`s:

##### `accepted`
```jsonc
{
  "kind": "accepted",
  "txHash": "ab8f…",
  "payment": {
    "txHash":      "ab8f…",
    "amountUnits": "1000000",
    "network":     "cardano:preprod",
    "unit":        "",                          // empty for lovelace
    "asset":       "lovelace",
    "resourceUrl": "/odata/v4/prices/Quotes",
    "nonceRef":    "<txHash>#<index>"
  },
  "paymentResponseB64": "<base64 of { success:true, network, transaction }>"
}
```

##### `rejected`
```jsonc
{
  "kind": "rejected",
  "code": "wrong_recipient",                    // canonical X402Code
  "reason": "no output paid to addr_test1...",
  "requirementsBody": { /* echoed back */ }
}
```

##### `pending`
```jsonc
{
  "kind": "pending",
  "code": "invalid_transaction_state",
  "txHash": "ab8f…",                            // optional, present if submit succeeded
  "reason": "tx submitted, not yet on chain",   // optional
  "requirementsBody": { /* echoed back */ }
}
```

#### Response: `≥ 400`

Any non-2xx status causes the client to throw. The middleware catches
that and returns `500 Internal Server Error` to the buyer. Bodies on
error responses are not parsed by the client and may carry diagnostic
info for operators.

#### Canonical `code` values

The `rejected` and `pending` response carries one of the codes from
`srv/core/errors.ts`:

| Stage     | Codes |
|---|---|
| Decode    | `missing_payment_header`, `invalid_base64`, `invalid_json`, `missing_field`, `unsupported_version`, `unsupported_scheme`, `unsupported_transfer_method`, `invalid_cbor`, `invalid_network_format`, `invalid_asset_format`, `invalid_nonce_format` |
| Validate  | `network_mismatch`, `wrong_recipient`, `insufficient_amount`, `wrong_asset`, `replay_detected`, `nonce_not_referenced`, `expired_ttl`, `unsigned_transaction` |
| Settle    | `submit_failed`, `invalid_transaction_state` (= pending) |
| Bridge    | `bridge_unavailable` |

A facilitator MAY extend with extra codes. Clients pass them through
to the buyer in the 402 `error` field, but SHOULD prefer the canonical
set for interoperability.

---

### `GET /supported`

Optional discovery endpoint. Used by tooling and health checks; the
middleware path does not call it.

#### Request

```http
GET /supported HTTP/1.1
Authorization: Bearer <apiKey>
```

#### Response: `200 OK`

```jsonc
{
  "networks":             ["cardano:mainnet", "cardano:preprod", "cardano:preview"],
  "assetTransferMethods": ["default"]
}
```

Future fields (non-breaking additions): per-network asset allow-lists,
maximum amounts, rate-limit hints.

---

## Timeouts

The client times out each request at `timeoutMs` (default `90_000`).
Facilitators SHOULD return a `pending` response, rather than letting
the request hang, once their internal `settlePollBudgetMs` elapses;
this gives the buyer a polling target via the returned `txHash`.

---

## Idempotency

`POST /verify-settle` is **not** idempotent at the network level (the
same envelope replayed produces the same accepted/rejected outcome,
but a fresh chain query happens each time). v2's nonce defense lives
on-chain: once the buyer's nonce UTxO is consumed, a replay rejects
with `replay_detected` and the facilitator MUST NOT charge it.

A facilitator MAY cache verified envelopes to short-circuit duplicate
submissions; if it does, it MUST honour the `Cache-Control: no-store`
header from the resource server (currently unused; reserved for
future buyer-driven cache-bust).

---

## Reference implementation

The local in-process facilitator (`localFacilitator()` in
`srv/facilitator/adapter.ts`) is the canonical reference. To stand up
a network-exposed version, wrap it in a thin Express server:

```typescript
import express from 'express';
import { localFacilitator } from '@odatano/x402';

const app = express();
app.use(express.json({ limit: '256kb' }));

const fac = localFacilitator();

app.post('/verify-settle', async (req, res) => {
  // (Add auth middleware here: bearer token check, mTLS, etc.)
  try {
    const result = await fac.verifyAndSettle(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/supported', async (_req, res) => {
  res.json(await fac.supported!());
});

app.listen(4040);
```

The deployed service then needs `@odatano/core` configured against
its own Cardano backend (Blockfrost / Koios / Ogmios). Resource servers
calling this facilitator do **not** need `@odatano/core` themselves;
that's the architectural win of the split.
