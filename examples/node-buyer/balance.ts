/**
 * Show the buyer wallet's UTxOs and total balance via the same
 * `@odatano/core` bridge the pay handler uses. Doubles as a check that
 * the backend config (BLOCKFROST_API_KEY + network) is wired correctly
 * before attempting a paid request.
 */

import { bridge } from '@odatano/x402';
import { loadWallet } from './wallet';

const ADA = 1_000_000n;

async function main(): Promise<void> {
  const wallet = loadWallet();
  console.log(`address: ${wallet.address}\n`);

  // Blockfrost 404s for addresses with no history; treat that as empty.
  const utxos = await bridge.getUtxosAtAddress(wallet.address)
    .catch((err: Error) => {
      if (/not found/i.test(err?.message ?? '')) return [];
      throw err;
    });
  if (utxos.length === 0) {
    console.log('No UTxOs. Fund the address from the faucet:');
    console.log('  https://docs.cardano.org/cardano-testnets/tools/faucet');
    return;
  }

  let total = 0n;
  for (const u of utxos) {
    total += BigInt(u.lovelace);
    const assets = u.assets.map(a => ` + ${a.quantity} ${a.unit.slice(0, 12)}…`).join('');
    console.log(`  ${u.txHash}#${u.outputIndex}  ${u.lovelace} lovelace${assets}`);
  }
  console.log(`\ntotal: ${total} lovelace (${Number(total) / Number(ADA)} ADA) across ${utxos.length} UTxO(s)`);
}

main()
  .then(() => bridge.shutdown())
  .then(() => process.exit(0))
  .catch(err => {
    console.error(`balance failed: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  });
