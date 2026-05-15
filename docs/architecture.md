# Architecture

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
            │ client/      ────┤ fetch + axios │
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

## Module layout

| Folder | Role | Touches chain? |
|---|---|---|
| `srv/core/` | Types, decode, validate, requirements builder, asset/network helpers, error codes | No |
| `srv/facilitator/` | `verify` (orchestrator), `settle`, `checkNonceUnspent`, adapter pattern (`localFacilitator`, `httpFacilitator`) | Yes (via `bridge`) |
| `srv/middleware/` | `x402Middleware` (Express), `gateService` (CAP) | No directly; calls facilitator |
| `srv/helpers/` | `buildUnsignedPaymentTx`, `verifyConfirmedPayment` | Yes (via `bridge`) |
| `srv/client/` | `x402Fetch`, `x402Axios`, `createBridgePayHandler`, `encodePaymentEnvelope` | Sometimes (`createBridgePayHandler` calls `buildUnsignedPaymentTx`) |
| `srv/bridge.ts` | Thin adapter over `@odatano/core` client. Single coupling point | Yes |

## Pure vs chain-touching split

Pure modules (`srv/core/*`) are decoupled from the bridge. You can unit-test them without any Cardano backend, mocked or otherwise. The chain-touching paths all funnel through `srv/bridge.ts`, which makes mocking trivial:

```typescript
jest.mock('../../srv/bridge', () => bridgeFactory());
```

The facilitator orchestrates `decode → validate → checkNonceUnspent → settle → onAccepted`. Each step has a dedicated module in `srv/facilitator/`; the orchestrator is `srv/facilitator/verify.ts`.

## Why the adapter pattern

The `Facilitator` interface in `srv/facilitator/adapter.ts` is the one extension point that lets you swap in:

- `localFacilitator()` (default): in-process via `@odatano/core`. Every resource server carries its own Cardano backend.
- `httpFacilitator({ url, apiKey })`: delegates verify+settle to a hosted service. Resource servers don't need `@odatano/core` themselves.
- Custom mock: for deterministic tests.

This split is the architectural mirror of what Coinbase ships with `@coinbase/x402` for the EVM-flavoured x402. See [`facilitator-protocol.md`](facilitator-protocol.md) for the HTTP wire format.

## Plugin auto-discovery

`cds-plugin.js` at the package root hooks `cds.on('served')` to warm up the `@odatano/core` bridge and `cds.on('shutdown')` to clean it up. The plugin never throws on init failure, so a missing Cardano backend won't crash the host CAP application; later bridge calls will fail with `BRIDGE_UNAVAILABLE` instead.

CAP scans `node_modules/` for packages with `cds-plugin.js`, so consumers don't need an explicit `import '@odatano/x402'` in their `srv/server.ts`.
