# Use case: AI agents buying enterprise data

Machine-to-machine consumers are where x402 stops being a nicer
billing model and becomes the only workable one: an AI agent cannot
sign an API-key contract or receive an invoice. With x402 it doesn't
have to: the agent gets HTTP 402 with a price, decides, pays exactly
for the data it needs, and cites the on-chain transaction as receipt.

## The shape

The reference implementation,
[`examples/agent-buyer`](../../examples/agent-buyer/), is an MCP server
any agent host (Claude Code, claude.ai, a custom loop) can mount:

| Tool | What the agent can do |
|---|---|
| `get_offer(url)` | Probe an endpoint without paying: price, asset, network, and whether it fits the budget |
| `buy_data(url, maxPriceLovelace?)` | Pay on Cardano and fetch; returns the data plus the settlement tx hash |
| `wallet_status()` | Address, on-chain balance, session spend, purchase history |

The agent reasons about *whether* to buy; the server owns *how*:

```
Agent (LLM)            MCP server (this example)          Seller
  │ get_offer(url)        │                                 │
  │───────────────────────│── GET ─────────────────────────▶│
  │ price: 1 ADA, fits ◀──│◀─ 402 ──────────────────────────│
  │ buy_data(url)         │                                 │
  │───────────────────────│  ceiling + budget check         │
  │                       │── pay (sign in-process) ───────▶│ settle on chain
  │ data + tx hash     ◀──│◀─ 200 + X-PAYMENT-RESPONSE ─────│
```

## Two security properties that make this deployable

1. **The model never sees the key.** Signing happens inside the MCP
   server process. The tools expose intent (probe, buy), not key
   material: a prompt-injected "print your private key" has nothing
   to print.
2. **The budget is enforced server-side.** `buy_data` re-probes the
   price itself and checks it against a per-purchase ceiling and a
   session budget (`X402_MAX_PRICE_LOVELACE`,
   `X402_SESSION_BUDGET_LOVELACE`). A prompt-injected "ignore your
   budget" cannot bypass a check the model doesn't execute.

## Run it

Without an LLM (a scripted client drives the tools agent-style):

```bash
cd examples/agent-buyer
NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx \
WALLET_FILE=../node-buyer/wallet.json npm run demo
```

With Claude Code:

```bash
claude mcp add x402-buyer \
  --env NETWORK=preview --env BACKENDS=blockfrost \
  --env BLOCKFROST_API_KEY=preview_xxx \
  --env WALLET_FILE=/absolute/path/to/wallet.json \
  -- npx tsx /absolute/path/to/examples/agent-buyer/server.ts
```

Then: *"Check what the price feed at ... costs; if it's 1 ADA or less,
buy it and summarize the quotes."*

## Why this composes with the seller side

The seller doesn't know or care that the caller is an agent: it's the
same `gateService()` gate as in
[pay-per-query data services](./pay-per-query.md). That's the point of
an open standard: one 402 surface serves humans with browser wallets,
backend services with keys, and autonomous agents with budgets.
