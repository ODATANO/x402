# Facilitator API

`@odatano/x402` speaks the x402 v2 facilitator API (§7 of the
specification). Any conformant facilitator works behind the middleware,
and `createFacilitatorRouter()` serves one that any x402 v2 resource
server can use.

```typescript
import { x402Middleware, httpFacilitator } from '@odatano/x402';

app.use('/api/premium', x402Middleware({
  payTo, network, asset, priceUnits,
  facilitator: httpFacilitator({ url: 'https://facilitator.example/v1', apiKey: process.env.FACILITATOR_API_KEY }),
}));
```

The resource server still decodes the payment transaction itself (for
the claim and `verifyTransfer`), so it needs `@odatano/core` installed,
but no Cardano backend of its own.

## Endpoints

All paths are relative to the configured `url`; a trailing slash is ignored.
With `apiKey` set, every request carries `Authorization: Bearer <apiKey>`;
a `headers()` builder adds anything else (mTLS, OAuth, signed requests).

### `POST /verify`

Read-only: checks the payment, never submits.

```json
{
  "x402Version": 2,
  "paymentPayload": { "x402Version": 2, "accepted": { "...": "..." }, "payload": { "transaction": "...", "nonce": "..." } },
  "paymentRequirements": { "scheme": "exact", "network": "cardano:preprod", "...": "the entry the payment is checked against" }
}
```

Answer (`VerifyResponse`):

```json
{ "isValid": true, "payer": "addr_test1..." }
{ "isValid": false, "invalidReason": "invalid_exact_cardano_payload_amount_insufficient", "extra": { "reason": "largest output to payTo carries 900000 < required 1000000 of lovelace" } }
```

### `POST /settle`

Same body. Claims the transaction id, submits once, waits (bounded) for
`confirmationPolicy`. Answer (`SettlementResponse`):

```json
{ "success": true, "transaction": "<tx hash>", "network": "cardano:preprod", "payer": "addr_test1...", "amount": "1000000",
  "extra": { "status": "confirmed", "confirmations": 1, "transactionId": "<tx hash>" } }
{ "success": false, "errorReason": "settlement_pending", "transaction": "<tx hash>", "network": "cardano:preprod",
  "extra": { "status": "pending", "confirmations": -1, "transactionId": "<tx hash>" } }
```

Call it again with the same body after `settlement_pending`: the
facilitator resumes observing; it submits again only if no backend is
known to have taken the transaction. A settled or
in-progress transaction answers `duplicate_settlement`.

### `GET /supported`

```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "cardano:preprod",
      "extra": { "assetTransferMethods": ["default", "script"], "areFeesSponsored": false, "l1Confirmations": { "minimum": 0, "maximum": 20 } } }
  ],
  "extensions": [],
  "signers": {}
}
```

Only the network the backend is connected to is listed. `signers` is
empty: a Cardano facilitator only relays the buyer's signed transaction
and signs nothing. `l1Confirmations.minimum` is -1 when
`allowMempoolConfirmation` is set.

### `GET /healthz`

Liveness, `{ "ok": true }`, not auth-gated.

## Reason codes

| Stage | Codes |
|---|---|
| Payload | `invalid_payload`, `invalid_x402_version`, `unsupported_scheme`, `invalid_network`, `invalid_exact_cardano_payload_transaction_decode_failed`, `invalid_exact_cardano_payload_nonce_invalid` |
| Requirements | `invalid_payment_requirements` (incl. `accepted` not offered), `invalid_exact_cardano_requirements`, `invalid_exact_cardano_requirements_policy` |
| Verification | `invalid_exact_cardano_payload_` + `network_id_mismatch`, `recipient_mismatch`, `amount_insufficient`, `asset_mismatch`, `nonce_not_in_inputs`, `nonce_not_on_chain`, `input_not_available`, `value_not_conserved`, `phase1_invalid`, `fee_below_minimum`, `unsigned`, `invalid_signature`, `not_yet_valid`, `ttl_expired`, `ttl_too_far`, `min_utxo_insufficient`, `script_address_mismatch`, `datum_missing`, `datum_mismatch` |
| Settlement | `settlement_pending`, `duplicate_settlement`, `exact_cardano_settlement_definitively_rejected`, `exact_cardano_settlement_failed`, `invalid_exact_cardano_payload_phase2_invalid`, `unexpected_settle_error` |
| Other | `unexpected_verify_error`; `transfer_rejected` (the resource server's `verifyTransfer`, never from a facilitator) |

## Serving a facilitator

```typescript
import express from 'express';
import { createFacilitatorRouter, localFacilitator, cdsSettlementStore } from '@odatano/x402';

const app = express();
app.use('/v1', createFacilitatorRouter({
  facilitator: localFacilitator({ store: cdsSettlementStore() }), // default: in-process store
  auth: (req) => req.headers.authorization === `Bearer ${process.env.FACILITATOR_API_KEY}`,
  onSettle: (response) => audit.log('x402.settle', response),
}));
app.listen(4040);
```

Without `auth` the router is open. Several instances behind one URL must
share the settlement store, or a pending retry that reaches another
instance will not find its claim. The service needs `@odatano/core`
configured against a Cardano backend.

`localFacilitator` options: `store`, `settlePollBudgetMs` (default 75 000),
`pollIntervalMs` (3 000), `claimGraceMs` (3 600 000),
`allowMempoolConfirmation` (false). The client's `timeoutMs` (default
90 000) must exceed the settle wait.
