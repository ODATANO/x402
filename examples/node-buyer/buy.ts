/**
 * Headless x402 buyer, the full flow in one script:
 *
 *   1. GET the gated endpoint with plain fetch → 402 + accepts[]
 *   2. x402Fetch + createBridgePayHandler:
 *        build unsigned payment tx (@odatano/core, server-side coin
 *        selection) → sign locally (buildooor vkey witness) → retry
 *        with PAYMENT-SIGNATURE header
 *   3. 200 OK: decode X-PAYMENT-RESPONSE for the settled tx hash
 *
 * Usage:
 *   BLOCKFROST_API_KEY=preprod_xxx npm run buy [-- <url>]
 * Default url: http://localhost:4004/odata/v4/prices/Quotes
 * (start examples/cap-app as the seller first).
 */

import {
  x402Fetch,
  createBridgePayHandler,
  bridge,
  type PaymentRequirementEntry,
} from '@odatano/x402';
import { loadWallet, createSignTx } from './wallet';

const url = process.argv[2] ?? 'http://localhost:4004/odata/v4/prices/Quotes';

function fmtPrice(r: PaymentRequirementEntry): string {
  return r.asset === 'lovelace'
    ? `${Number(r.amount) / 1_000_000} ADA`
    : `${r.amount} of ${r.asset}`;
}

function explorerUrl(network: string, txHash: string): string {
  const sub = network.endsWith('preprod') ? 'preprod.'
    : network.endsWith('preview') ? 'preview.'
    : '';
  return `https://${sub}cardanoscan.io/transaction/${txHash}`;
}

async function main(): Promise<void> {
  const wallet = loadWallet();
  console.log(`buyer:  ${wallet.address}`);
  console.log(`target: ${url}\n`);

  // ─── 1. Unpaid probe: show what the server demands ──────────────────
  const probe = await fetch(url);
  if (probe.status !== 402) {
    console.log(`Endpoint answered ${probe.status}, not 402. Nothing to pay for.`);
    console.log(await probe.text());
    return;
  }
  const body = await probe.json() as { accepts: PaymentRequirementEntry[] };
  const offer = body.accepts[0]!;
  console.log('402 Payment Required. Server accepts:');
  console.log(`  price:   ${fmtPrice(offer)}`);
  console.log(`  payTo:   ${offer.payTo}`);
  console.log(`  network: ${offer.network}\n`);

  // ─── 2. Pay and retry ────────────────────────────────────────────────
  let chosen: PaymentRequirementEntry | undefined;
  const payHandler = createBridgePayHandler({
    buyerBech32: wallet.address,
    signTx: createSignTx(wallet.privateKeyHex),
  });

  const paidFetch = x402Fetch({
    errorOnFailure: true,
    pay: async (requirement) => {
      chosen = requirement;
      console.log(`Paying ${fmtPrice(requirement)}: build → sign → retry ...`);
      return payHandler(requirement);
    },
  });

  const res = await paidFetch(url);
  console.log(`\n${res.status} ${res.statusText}`);

  // ─── 3. Settlement receipt ───────────────────────────────────────────
  const receiptB64 = res.headers.get('X-PAYMENT-RESPONSE');
  if (receiptB64 && chosen) {
    const receipt = JSON.parse(Buffer.from(receiptB64, 'base64').toString('utf8')) as {
      transaction: string;
    };
    console.log(`settled tx: ${receipt.transaction}`);
    console.log(`explorer:   ${explorerUrl(chosen.network, receipt.transaction)}\n`);
  }

  const data = await res.text();
  console.log(data.length > 600 ? data.slice(0, 600) + ' …' : data);
}

main()
  .then(() => bridge.shutdown())
  .then(() => process.exit(0))
  .catch(err => {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`\nbuy failed: ${msg}`);
    if (/not found|insufficient/i.test(msg)) {
      console.error('The buyer wallet looks unfunded. Fund it from the faucet, then check with `npm run balance`:');
      console.error('  https://docs.cardano.org/cardano-testnets/tools/faucet');
    }
    process.exit(1);
  });
