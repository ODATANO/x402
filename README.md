![PDATANOX402](datano-x402.png)
# @odatano/x402

[![Tests](https://github.com/ODATANO/x402/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/x402/actions/workflows/test.yaml)
[![Coverage](https://codecov.io/gh/ODATANO/x402/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/x402)
[![@odatano/core](https://img.shields.io/badge/@odatano/core-1.9.1-blue)](https://www.npmjs.com/package/@odatano/core)
[![npm](https://img.shields.io/npm/v/@odatano/x402?color=blue&logo=npm)](https://www.npmjs.com/package/@odatano/x402)
[![npm downloads](https://img.shields.io/npm/dt/@odatano/x402?logo=npm&label=downloads&color=blue)](https://www.npmjs.com/package/@odatano/x402)
[![License](https://img.shields.io/badge/license-Apache%202.0-yellow)](LICENSE)

x402 payment gating for SAP CAP applications, backed by Cardano.

Wire a single `before('*')` hook into your CAP service. Every gated request returns **HTTP 402 Payment Required** until the caller proves on-chain settlement. Asset-agnostic: pay in ADA, USDM, or any native asset.

Implements the **Cardano-x402-v2** spec on top of [`@odatano/core`](https://www.npmjs.com/package/@odatano/core).

## Use cases

Sell enterprise data per request instead of per API-key contract: no
partner onboarding, no invoicing run, and the same 402 surface serves
humans, backend services, and AI agents.

- **Pay-per-query data services** (including B2B lookups and per-call reports): [docs/use-cases/pay-per-query.md](docs/use-cases/pay-per-query.md)
- **AI agents buying data autonomously**: [docs/use-cases/ai-agent-payments.md](docs/use-cases/ai-agent-payments.md)

Each page links its reference implementation; runnable versions are listed under [Examples](#examples).

## Install

```bash
npm install @odatano/x402 @odatano/core
```

`@odatano/core` (the Cardano bridge) is a peer dependency. Install whichever version meets `>=1.9.1`.

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
        // Lovelace prices must clear Cardano's min-UTxO (~0.98 ADA),
        // the payment is a real output; 1 ADA is the practical floor.
        Quotes:       '1000000',          // 1 ADA per Quotes read
        getBestPrice: '2000000',          // 2 ADA per getBestPrice action call
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

## Examples

| Example | Role | Shows |
|---|---|---|
| [`examples/cap-app/`](examples/cap-app/) | Seller | CAP service with gated entities/actions via `gateService()` |
| [`examples/node-buyer/`](examples/node-buyer/) | Buyer | Headless machine-to-machine buyer: local key + `x402Fetch`, full 402 → pay → 200 round-trip from the terminal |
| [`examples/agent-buyer/`](examples/agent-buyer/) | Buyer (AI agent) | MCP server exposing `get_offer`/`buy_data` tools so an AI agent buys gated data autonomously, with a hard spend budget |
| [`examples/browser-buyer/`](examples/browser-buyer/) | Buyer | CIP-30 wallet + `x402Fetch` in the browser |
| [`examples/facilitator-server/`](examples/facilitator-server/) | Facilitator | Hosted verify+settle service for `httpFacilitator()` |

Fastest end-to-end demo, one command (needs a funded wallet at `examples/node-buyer/wallet.json`, see its [README](examples/node-buyer/README.md)):

```bash
NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx npm run demo
```

It starts the `cap-app` seller, runs the `node-buyer` buy flow against it (402 → pay on Cardano → 200), and prints the persisted receipt from the seller's free `Settlements` view.

## Documentation

Use-case pages are linked above; the technical references:

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
- `@odatano/core >= 1.9.1` (peer)
- `express ^4` (peer), only if you use `x402Middleware`
- A Cardano backend reachable via `@odatano/core` (Blockfrost / Koios / Ogmios)

## Development

```bash
npm install                # Workspace install: covers root + examples/*
npm run build              # tsc, emits .js/.d.ts next to .ts (outDir: .)
npm test                   # 232 tests, ~13s
```

## License

Apache-2.0 (see [LICENSE](LICENSE))
