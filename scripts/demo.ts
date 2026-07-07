/**
 * One-command x402 demo: seller up → 402 → pay on Cardano → 200 → receipt.
 *
 *   NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=... npm run demo
 *
 * Spawns examples/cap-app as the seller, waits for the gate, runs the
 * examples/node-buyer buy flow against it, then reads the seller's free
 * Settlements view to show the persisted receipt. Cleans up the seller
 * on exit.
 *
 * Preconditions (the script checks and explains each):
 *   - BLOCKFROST_API_KEY (+ NETWORK/BACKENDS) for both sides
 *   - a funded wallet at examples/node-buyer/wallet.json
 *     (npm run generate-wallet there + testnet faucet)
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const ROOT = resolve(import.meta.dirname, '..');
const SELLER_DIR = resolve(ROOT, 'examples/cap-app');
const BUYER_DIR = resolve(ROOT, 'examples/node-buyer');
const PORT = process.env.PORT ?? '4204';
const BASE = `http://localhost:${PORT}/odata/v4/prices`;

function fail(msg: string): never {
  console.error(`\ndemo: ${msg}`);
  process.exit(1);
}

// ─── Preconditions ─────────────────────────────────────────────────────
if (!process.env.BLOCKFROST_API_KEY) {
  fail('BLOCKFROST_API_KEY is not set. Both sides need a Cardano backend:\n' +
       '  NETWORK=preview BACKENDS=blockfrost BLOCKFROST_API_KEY=preview_xxx npm run demo');
}
const walletPath = resolve(BUYER_DIR, 'wallet.json');
if (!existsSync(walletPath)) {
  fail(`no buyer wallet at ${walletPath}.\n` +
       '  cd examples/node-buyer && npm run generate-wallet\n' +
       '  then fund the printed address: https://docs.cardano.org/cardano-testnets/tools/faucet');
}

// ─── Seller ────────────────────────────────────────────────────────────
const cdsBin = req.resolve('@sap/cds-dk/bin/cds.js');
const tsxCli = req.resolve('tsx/cli');

let seller: ChildProcess | null = null;
function stopSeller() {
  if (seller && !seller.killed) seller.kill();
}
process.on('exit', stopSeller);
process.on('SIGINT', () => process.exit(130));

async function waitForGate(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/Quotes`);
      if (res.status === 402) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`seller did not serve a 402 within ${timeoutMs / 1000}s`);
}

async function main(): Promise<void> {
  console.log(`[demo] starting seller (examples/cap-app) on :${PORT} ...`);
  seller = spawn(process.execPath, [cdsBin, 'serve'], {
    cwd: SELLER_DIR,
    env: { ...process.env, PORT },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  seller.on('exit', code => {
    if (code != null && code !== 0) fail(`seller exited with code ${code}`);
  });

  await waitForGate();
  console.log(`[demo] gate is up: GET ${BASE}/Quotes -> 402\n`);

  // ─── Buyer: full 402 → pay → 200 round-trip ──────────────────────────
  const buyer = spawn(process.execPath, [tsxCli, 'buy.ts', `${BASE}/Quotes`], {
    cwd: BUYER_DIR,
    env: process.env,
    stdio: 'inherit',
  });
  const buyerExit: number = await new Promise(res => buyer.on('exit', c => res(c ?? 1)));
  if (buyerExit !== 0) fail('buy flow failed (see output above)');

  // ─── Seller-side receipt ─────────────────────────────────────────────
  const settlements = await fetch(
    `${BASE}/Settlements?$select=txHash,amount,asset,route&$orderby=at desc&$top=1`,
  ).then(r => r.json()) as { value: unknown[] };
  console.log('\n[demo] seller-side receipt (free Settlements view):');
  console.log(JSON.stringify(settlements.value[0] ?? null, null, 2));

  console.log('\n[demo] done: 402 served, payment settled on chain, receipt persisted.');
}

main()
  .then(() => { stopSeller(); process.exit(0); })
  .catch(err => { stopSeller(); fail((err as Error)?.message ?? String(err)); });
