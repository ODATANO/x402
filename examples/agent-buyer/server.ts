/**
 * x402 agent-buyer: an MCP server that lets an AI agent buy x402-gated
 * data autonomously: probe the price, decide, pay on Cardano, return
 * the data with the on-chain receipt.
 *
 * The agent never touches the key: signing happens in-process, and a
 * hard budget caps what a session can spend regardless of what the
 * model asks for.
 *
 * Tools:
 *   get_offer(url)                    - probe an endpoint, report price/asset/network
 *   buy_data(url, maxPriceLovelace?)  - pay and fetch, enforcing price ceiling + session budget
 *   wallet_status()                   - address, balance, budget remaining, purchases so far
 *
 * Env: NETWORK / BACKENDS / BLOCKFROST_API_KEY (backend, as in node-buyer),
 *      WALLET_FILE (default ./wallet.json),
 *      X402_MAX_PRICE_LOVELACE   per-purchase ceiling (default 2 ADA),
 *      X402_SESSION_BUDGET_LOVELACE  total session cap (default 10 ADA).
 */

import './redirect-console'; // keep stdout clean for MCP, must stay first

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  x402Fetch,
  createBridgePayHandler,
  bridge,
  type PaymentRequirementEntry,
} from '@odatano/x402';
import { loadWallet, createSignTx } from './wallet';

const MAX_PRICE = BigInt(process.env.X402_MAX_PRICE_LOVELACE ?? '2000000');
const SESSION_BUDGET = BigInt(process.env.X402_SESSION_BUDGET_LOVELACE ?? '10000000');

const wallet = loadWallet();
const payHandler = createBridgePayHandler({
  buyerBech32: wallet.address,
  signTx: createSignTx(wallet.privateKeyHex),
});

let spent = 0n;
const purchases: Array<{ url: string; priceLovelace: string; txHash: string }> = [];

function text(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

async function probe(url: string): Promise<
  | { status: 'free' | 'error'; httpStatus: number; body: string }
  | { status: 'payment_required'; offer: PaymentRequirementEntry }
> {
  const res = await fetch(url);
  if (res.status !== 402) {
    return {
      status: res.ok ? 'free' : 'error',
      httpStatus: res.status,
      body: (await res.text()).slice(0, 500),
    };
  }
  const body = await res.json() as { accepts?: PaymentRequirementEntry[] };
  const offer = body.accepts?.[0];
  if (!offer) throw new Error('402 response carried no accepts[] entry');
  return { status: 'payment_required', offer };
}

const server = new McpServer({ name: 'x402-agent-buyer', version: '0.1.0' });

server.registerTool(
  'get_offer',
  {
    description:
      'Probe an x402-gated HTTP endpoint without paying. Returns the price, asset, ' +
      'network and payTo address the server demands, or reports that the endpoint is free. ' +
      'Call this before buy_data to decide whether the price is acceptable.',
    inputSchema: { url: z.string().url().describe('The endpoint to probe') },
  },
  async ({ url }) => {
    const p = await probe(url);
    if (p.status !== 'payment_required') return text(p);
    const { offer } = p;
    return text({
      status: 'payment_required',
      priceLovelace: offer.asset === 'lovelace' ? offer.amount : null,
      priceAda: offer.asset === 'lovelace' ? Number(offer.amount) / 1_000_000 : null,
      asset: offer.asset,
      network: offer.network,
      payTo: offer.payTo,
      description: offer.resource?.description ?? null,
      withinBudget:
        offer.asset === 'lovelace' &&
        BigInt(offer.amount) <= MAX_PRICE &&
        spent + BigInt(offer.amount) <= SESSION_BUDGET,
    });
  },
);

server.registerTool(
  'buy_data',
  {
    description:
      'Pay for and fetch an x402-gated endpoint. Settles the price on Cardano and returns ' +
      'the response data plus the on-chain transaction hash as receipt. Refuses if the price ' +
      'exceeds the per-purchase ceiling or the remaining session budget.',
    inputSchema: {
      url: z.string().url().describe('The endpoint to buy'),
      maxPriceLovelace: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe('Optional stricter price ceiling for this purchase, in lovelace'),
    },
  },
  async ({ url, maxPriceLovelace }) => {
    const p = await probe(url);
    if (p.status !== 'payment_required') {
      return text({ ...p, note: 'Nothing to pay for; returned the response as-is.' });
    }
    const { offer } = p;

    if (offer.asset !== 'lovelace') {
      return text({
        refused: `Offer is priced in native asset ${offer.asset}; this buyer only pays in lovelace.`,
      });
    }
    const price = BigInt(offer.amount);
    const ceiling = maxPriceLovelace ? BigInt(maxPriceLovelace) : MAX_PRICE;
    if (price > ceiling) {
      return text({
        refused: `Price ${price} lovelace exceeds the ceiling of ${ceiling} lovelace.`,
        priceLovelace: price.toString(),
      });
    }
    if (spent + price > SESSION_BUDGET) {
      return text({
        refused: `Price ${price} lovelace exceeds the remaining session budget of ${SESSION_BUDGET - spent} lovelace.`,
        spentLovelace: spent.toString(),
        budgetLovelace: SESSION_BUDGET.toString(),
      });
    }

    let receipt: { transaction: string } | null = null;
    const paidFetch = x402Fetch({ pay: payHandler, errorOnFailure: true });
    const res = await paidFetch(url);

    const receiptB64 = res.headers.get('X-PAYMENT-RESPONSE');
    if (receiptB64) {
      receipt = JSON.parse(Buffer.from(receiptB64, 'base64').toString('utf8'));
    }
    const txHash = receipt?.transaction ?? null;
    if (txHash) {
      spent += price;
      purchases.push({ url, priceLovelace: price.toString(), txHash });
    }

    const data = await res.text();
    return text({
      httpStatus: res.status,
      paidLovelace: price.toString(),
      txHash,
      data: data.length > 4000 ? data.slice(0, 4000) + ' …[truncated]' : data,
      spentLovelace: spent.toString(),
      budgetRemainingLovelace: (SESSION_BUDGET - spent).toString(),
    });
  },
);

server.registerTool(
  'wallet_status',
  {
    description:
      'Show the buyer wallet address, its on-chain balance, the session spend budget, ' +
      'and the purchases made so far in this session.',
    inputSchema: {},
  },
  async () => {
    const utxos = await bridge.getUtxosAtAddress(wallet.address)
      .catch((err: Error) => {
        if (/not found/i.test(err?.message ?? '')) return [];
        throw err;
      });
    const balance = utxos.reduce((sum, u) => sum + BigInt(u.lovelace), 0n);
    return text({
      address: wallet.address,
      balanceLovelace: balance.toString(),
      balanceAda: Number(balance) / 1_000_000,
      maxPricePerPurchaseLovelace: MAX_PRICE.toString(),
      sessionBudgetLovelace: SESSION_BUDGET.toString(),
      spentLovelace: spent.toString(),
      purchases,
    });
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`[agent-buyer] MCP server up. wallet=${wallet.address} budget=${SESSION_BUDGET} lovelace`);
}

main().catch(err => {
  console.error('agent-buyer failed to start:', err);
  process.exit(1);
});
