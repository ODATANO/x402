# x402 node-buyer example

Headless buyer for x402-gated APIs: a local ed25519 key + `x402Fetch`,
no browser, no CIP-30 wallet. This is the machine-to-machine shape, an
AI agent or backend service paying for data autonomously, and the
fastest way to see the full 402 → pay → 200 round-trip in a terminal.

## What it shows

1. `generate-wallet.ts`: raw key generation + enterprise testnet
   address derivation with buildooor (no wallet software involved).
2. `createBridgePayHandler` + a local `signTx`: the unsigned tx comes
   from `@odatano/core` (UTxO selection, change, fee), the vkey witness
   is attached locally with `Tx.signWith`.
3. `x402Fetch` doing the 402 → pay → retry loop transparently.
4. Decoding `X-PAYMENT-RESPONSE` for the settled tx hash.

## Quick start

You need a [Blockfrost](https://blockfrost.io) project key for the
network your seller runs on. The buyer's backend is configured purely
via env vars (same three the seller uses):

```bash
cd examples/node-buyer
export NETWORK=preprod BACKENDS=blockfrost BLOCKFROST_API_KEY=preprod_xxx

# 1. Create a buyer wallet (writes wallet.json, prints the address)
npm run generate-wallet

# 2. Fund the address from the faucet, then confirm:
#    https://docs.cardano.org/cardano-testnets/tools/faucet
npm run balance

# 3. Pay for a gated request
npm run buy
```

Expected output of `npm run buy`:

```
buyer:  addr_test1vz...
target: http://localhost:4004/odata/v4/prices/Quotes

402 Payment Required. Server accepts:
  price:   1 ADA
  payTo:   addr_test1qq...
  network: cardano:preprod

Paying 1 ADA: build → sign → retry ...

200 OK
settled tx: 4f21ac...
explorer:   https://preprod.cardanoscan.io/transaction/4f21ac...

{"@odata.context":"$metadata#Quotes","value":[...]}
```

`npm run buy -- <url>` targets any other x402-gated endpoint.

## Running the seller

The default target is [`examples/cap-app`](../cap-app/). Its gate
verifies and settles on chain, so it needs a backend too:

```bash
cd examples/cap-app
NETWORK=preprod BACKENDS=blockfrost BLOCKFROST_API_KEY=preprod_xxx npm run watch
```

(One Blockfrost key for both sides is fine.)

## Configuration

All via env vars (`@odatano/core` standalone mode):

| Env var | Meaning | Default |
|---|---|---|
| `NETWORK` | `preprod` \| `preview` \| `mainnet` | `preview` |
| `BACKENDS` | comma-separated: `blockfrost`, `koios`, `ogmios` | `koios` |
| `BLOCKFROST_API_KEY` | Blockfrost project key for `NETWORK` |, |
| `WALLET_FILE` | wallet file location | `./wallet.json` |

Note: CAP does not expand `${...}` placeholders in `cds.requires`, so
this example deliberately ships no `cds.requires.odatano-core` block,
env vars are the whole configuration.

## Security notes

- **Test networks only.** The key is plain JSON on disk. For anything
  real, back `signTx` with a KMS/HSM, the `PayHandler` contract doesn't
  care where the signature comes from.
- `wallet.json` is gitignored. `--force` on `generate-wallet`
  overwrites the key; funds on the old address become unreachable.
