# x402 facilitator server example

Minimal HTTP facilitator built on `createFacilitatorRouter`. Resource
servers using `httpFacilitator()` point at this URL to delegate the
verify+settle pipeline.

## Run

```bash
cd examples/facilitator-server
BLOCKFROST_API_KEY=preprod_xxx FACILITATOR_API_KEY=secret npm start
# → [facilitator] listening on http://127.0.0.1:4040/v1
```

Network and backend are configured in `package.json` under
`cds.requires.odatano-core`; the Blockfrost key comes from the
`BLOCKFROST_API_KEY` env var. (CAP does not expand `${...}` placeholders
in `cds.requires`, so the key must stay out of `package.json`,
`@odatano/core` falls back to the env var when the config omits it.)

## Endpoints

| Method | Path                | Auth          | Purpose                       |
|--------|---------------------|---------------|-------------------------------|
| POST   | `/v1/verify`        | Bearer apiKey | Verify a payment (read-only)  |
| POST   | `/v1/settle`        | Bearer apiKey | Submit and confirm a payment  |
| GET    | `/v1/supported`     | Bearer apiKey | Supported kinds               |
| GET    | `/v1/healthz`       | (open)        | Liveness probe                |

The x402 v2 facilitator API, so any x402 v2 resource server can use it.
Details: [`docs/facilitator-protocol.md`](../../docs/facilitator-protocol.md).

## Use from a resource server

```typescript
import { x402Middleware, httpFacilitator } from '@odatano/x402';

app.use('/api/premium', x402Middleware({
  payTo, network, asset, priceUnits,
  facilitator: httpFacilitator({
    url:    'http://127.0.0.1:4040/v1',
    apiKey: process.env.FACILITATOR_API_KEY,
  }),
}));
```
