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
                                  │   @odatano/core 2.0    │
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
| `srv/core/` | Types, payload parsing, `accepted` matching, decode, structural verification rules, requirements builder, transfer methods, asset/network helpers, reason codes | No (decode and script hashing call pure core helpers) |
| `srv/facilitator/` | `verify` (read-only), `settle`, chain rules (`chain.ts`), settlement claims (`store.ts`, `cds-store.ts`), `localFacilitator`, `httpFacilitator`, `createFacilitatorRouter` | Yes (via `bridge`) |
| `srv/middleware/` | `x402Middleware` (Express), `gateService` (CAP), the shared `authorization` flow (`flow.ts`), issued requirements | Not directly; calls the facilitator |
| `srv/helpers/` | `buildUnsignedPaymentTx`, `verifyConfirmedPayment`, address parsing | Yes (via `bridge`) |
| `srv/client/` | `x402Fetch`, `x402Axios`, header protocol (`protocol.ts`), `createBridgePayHandler` | Sometimes (`createBridgePayHandler` calls `buildUnsignedPaymentTx`) |
| `srv/bridge.ts` | Thin adapter over `@odatano/core` client. Single coupling point | Yes |

## Pure vs chain-touching split

Pure modules (`srv/core/*`) are decoupled from the bridge. You can unit-test them without any Cardano backend, mocked or otherwise. The chain-touching paths all funnel through `srv/bridge.ts`, which makes mocking trivial:

```typescript
jest.mock('../../srv/bridge', () => bridgeFactory());
```

A request runs `startPayment` (parse, match `accepted`, facilitator `verify`, `verifyTransfer`), then the protected handler, then `finishPayment` (facilitator `settle`). `verify` combines the structural rules (`core/validate.ts`) with the chain rules (`facilitator/chain.ts`); `settle` claims the transaction id, submits once and waits for the confirmation policy.

## Why the adapter pattern

The `Facilitator` interface in `srv/facilitator/adapter.ts` is the one extension point that lets you swap in:

- `localFacilitator()`: in-process via `@odatano/core`. The default is one shared instance per process (`defaultFacilitator()`). Every resource server carries its own Cardano backend.
- `httpFacilitator({ url, apiKey })`: any x402 v2 facilitator over HTTP. Resource servers still decode payments locally, so they need `@odatano/core` installed, but no Cardano backend.
- Custom mock: for deterministic tests.

The interface and the HTTP API are those of the x402 v2 specification, so facilitators are interchangeable with other implementations. See [`facilitator-protocol.md`](facilitator-protocol.md).

## Plugin auto-discovery

`cds-plugin.js` at the package root hooks `cds.on('served')` to warm up the `@odatano/core` bridge and `cds.on('shutdown')` to clean it up. The plugin never throws on init failure, so a missing Cardano backend won't crash the host CAP application; later bridge calls will fail with `BRIDGE_UNAVAILABLE` instead.

CAP scans `node_modules/` for packages with `cds-plugin.js`, so consumers don't need an explicit `import '@odatano/x402'` in their `srv/server.ts`.
