/**
 * Send tADA from our wallet to the cf wallet, so both sides can pay.
 *
 *   BLOCKFROST_API_KEY=preview_... NETWORK=preview BACKENDS=blockfrost npm run fund [-- <ada>]
 */

import { bridge } from '@odatano/x402';
import { cfClientSigner, ourWallet } from './wallets';

async function main(): Promise<void> {
  const ada = Number(process.argv[2] ?? '40');
  const ours = ourWallet();
  const cfAddress = cfClientSigner().getAddress();
  console.log(`funding ${cfAddress} with ${ada} tADA from ${ours.address}`);

  const built = await bridge.buildUnsignedTransfer({
    senderAddress:    ours.address,
    recipientAddress: cfAddress,
    lovelaceAmount:   String(Math.round(ada * 1_000_000)),
    validityEndMs:    Date.now() + 600_000,
  });
  const txHash = await bridge.submitTransaction(await ours.signTx(built.unsignedTxCbor));
  console.log(`submitted ${txHash}`);
}

main()
  .then(() => bridge.shutdown())
  .then(() => process.exit(0))
  .catch((err) => { console.error('fund failed:', (err as Error)?.message ?? err); process.exit(1); });
