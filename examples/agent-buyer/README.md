# x402 agent-buyer example

An MCP server that gives any AI agent (Claude Code, claude.ai, or your
own agent loop) the ability to **buy x402-gated data autonomously**:
probe the price, decide, settle on Cardano, and hand the data back with
the on-chain transaction hash as receipt.

The key stays server-side, and a hard budget caps what a session can
spend no matter what the model asks for. This is the enterprise
machine-to-machine story end to end: no account, no API key contract,
no invoice: an agent pays for exactly the data it needs.

## Tools exposed

| Tool | What it does |
|---|---|
| `get_offer(url)` | Probe without paying: price, asset, network, payTo, and whether it fits the budget |
| `buy_data(url, maxPriceLovelace?)` | Pay + fetch. Refuses above the per-purchase ceiling or remaining session budget |
| `wallet_status()` | Address, on-chain balance, budget spent/remaining, purchases this session |

## Setup

The wallet format is shared with [`examples/node-buyer`](../node-buyer/):

```bash
# Reuse the node-buyer wallet (recommended):
export WALLET_FILE=../node-buyer/wallet.json
# ...or generate a fresh one there and copy wallet.json here.

# Backend config, same env vars as everywhere else:
export NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx

# Budget knobs (optional):
export X402_MAX_PRICE_LOVELACE=2000000        # per-purchase ceiling, default 2 ADA
export X402_SESSION_BUDGET_LOVELACE=10000000  # session cap, default 10 ADA
```

## Try it without an LLM

`demo.ts` drives the server over stdio exactly like an agent would
(status → probe → buy):

```bash
# Terminal 1: the seller
cd examples/cap-app
NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx npm run watch

# Terminal 2: the agent
cd examples/agent-buyer
NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx \
WALLET_FILE=../node-buyer/wallet.json npm run demo
```

## Wire it into Claude Code

```bash
claude mcp add x402-buyer \
  --env NETWORK=preview \
  --env BACKENDS=blockfrost \
  --env BLOCKFROST_API_KEY=preview_xxx \
  --env WALLET_FILE=/absolute/path/to/wallet.json \
  -- npx tsx /absolute/path/to/examples/agent-buyer/server.ts
```

Then ask Claude: *"Check what the price feed at
http://localhost:4004/odata/v4/prices/Quotes costs, and if it's 1 ADA
or less, buy it and summarize the quotes."* The agent will probe via
`get_offer`, reason about the price, pay via `buy_data`, and cite the
settlement transaction.

## Design notes

- **stdout discipline:** MCP over stdio owns stdout, but `@sap/cds`
  logs through `console.*`. `redirect-console.ts` (the first import)
  reroutes all console output to stderr.
- **The model never sees the key.** Signing happens inside the server
  process; the tools expose intent (buy/probe), not key material.
- **Budget is enforced server-side.** `buy_data` re-probes the price
  itself and checks it against the ceiling and session budget:
  prompt-injected "ignore your budget" cannot bypass it.
- **Test networks only.** Plain-JSON key on disk; for production, back
  `createSignTx` with a KMS/HSM.
