/**
 * Generate a fresh buyer key + enterprise testnet address and write it
 * to wallet.json. Refuses to overwrite an existing wallet unless
 * --force is passed (the old key would be gone, and with it any funds).
 *
 * The same addr_test1v... address works on both preprod and preview;
 * which network the buyer actually talks to is decided by the
 * odatano-core config in package.json.
 */

import { randomBytes } from 'crypto';
import {
  Address,
  Credential,
  PubKeyHash,
  blake2b_224,
  deriveEd25519PublicKey_sync,
} from '@harmoniclabs/buildooor';
import { WALLET_PATH, walletExists, saveWallet } from './wallet';

if (walletExists() && !process.argv.includes('--force')) {
  console.error(`Wallet already exists at ${WALLET_PATH}.`);
  console.error('Delete it or pass --force to overwrite (funds on the old address will be unreachable).');
  process.exit(1);
}

const priv = randomBytes(32);
const pub = deriveEd25519PublicKey_sync(priv);
const keyHash = blake2b_224(Buffer.from(pub));
const address = new Address({
  network: 'testnet',
  paymentCreds: Credential.keyHash(new PubKeyHash(Buffer.from(keyHash))),
}).toString();

saveWallet({ privateKeyHex: priv.toString('hex'), address });

console.log(`Wallet written to ${WALLET_PATH}\n`);
console.log(`  address: ${address}\n`);
console.log('Next steps:');
console.log('  1. Fund it from the testnet faucet (pick the network your seller runs on):');
console.log('     https://docs.cardano.org/cardano-testnets/tools/faucet');
console.log('  2. BLOCKFROST_API_KEY=preprod_xxx npm run balance   # confirm the funds arrived');
console.log('  3. BLOCKFROST_API_KEY=preprod_xxx npm run buy       # pay for a gated request');
