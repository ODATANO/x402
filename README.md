# @odatano/x402

x402 payment gating for SAP CAP applications, backed by Cardano.

Wire a single `before('*')` hook into your CAP service. Every gated request returns **HTTP 402 Payment Required** until the caller proves on-chain settlement. Asset-agnostic: pay in ADA, USDM, or any native asset.

Implements the **Cardano-x402-v2** spec on top of [`@odatano/core`](https://www.npmjs.com/package/@odatano/core).

## Install

```bash
npm install @odatano/x402 @odatano/core
```

`@odatano/core` (the Cardano bridge) is a peer dependency. Install whichever version meets `>=1.7.8`.

## Quick Start

```typescript
// srv/prices-service.ts
import cds from '@sap/cds';
import { gateService } from '@odatano/x402';

export class PricesService extends cds.ApplicationService {
  async init() {
    gateService(this, {
      payTo:   'addr_test1...your-preprod-address...',
      network: 'cardano:preprod',
      asset:   'lovelace',                // or '<policy>.<nameHex>' for native tokens
      routePricing: {
        Quotes:       '500000',           // 0.5 ADA per Quotes read
        getBestPrice: '1000000',          // 1 ADA per getBestPrice action call
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

`cds watch`, then probe a gated route: it returns `402` with a v2-shape body. A working example lives in [`examples/cap-app/`](examples/cap-app/).

## What's in the box

- **`gateService(srv, opts)`** for CAP services and **`x402Middleware(opts)`** for plain Express routes.
- **`x402Fetch` / `x402Axios`** wrappers that auto-handle 402 on the client side.
- **`Facilitator` adapter:** `localFacilitator()` (default, in-process via `@odatano/core`) or `httpFacilitator()` to delegate verify+settle to a hosted service.
- **Helpers:** `buildUnsignedPaymentTx` (browser-buyer flow), `verifyConfirmedPayment` (post-paid / subscription).

## Documentation

| Doc | Covers |
|---|---|
| [`docs/usage.md`](docs/usage.md) | All five usage patterns + full configuration reference |
| [`docs/protocol.md`](docs/protocol.md) | Buyer-flow diagram, `PAYMENT-SIGNATURE` envelope, the six mandatory facilitator checks |
| [`docs/architecture.md`](docs/architecture.md) | Module layout, pure-vs-chain split, plugin auto-discovery |
| [`docs/facilitator-protocol.md`](docs/facilitator-protocol.md) | HTTP wire format for the hosted-facilitator pattern (`httpFacilitator()`) |
| [`CHANGELOG.md`](CHANGELOG.md) | Versioned changes, latest first |

## Requirements

- Node.js 22+
- `@sap/cds >= 9` (peer)
- `@odatano/core >= 1.7.8` (peer)
- `express ^4` (peer), only if you use `x402Middleware`
- A Cardano backend reachable via `@odatano/core` (Blockfrost / Koios / Ogmios)

## Development

```bash
npm install                # Workspace install: covers root + examples/*
npm run build              # tsc, emits .js/.d.ts next to .ts (outDir: .)
npm test                   # 177 tests, ~13s
```

## License

Apache-2.0.
