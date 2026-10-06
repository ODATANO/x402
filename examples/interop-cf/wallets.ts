/**
 * The two test wallets of the interop checks, preview only:
 *
 *   - ours: the node-buyer key wallet (`../node-buyer/wallet.json`), pays
 *     through `@odatano/x402`;
 *   - cf: a BIP-39 mnemonic wallet (`cf-wallet.json`), pays through the
 *     `@x402/cardano` reference signer, which needs a mnemonic.
 *
 * Keys sit unencrypted on disk. Never fund them with mainnet ADA.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { toClientCardanoSigner } from '@x402/cardano';
import { createSignTx, type WalletFile } from '../node-buyer/wallet';

export const NETWORK = 'cardano:preview';

export function blockfrostKey(): string {
  const key = process.env.BLOCKFROST_API_KEY;
  if (!key) throw new Error('BLOCKFROST_API_KEY (preview) is required');
  return key;
}

export const cfProvider = () => ({
  blockfrost: { baseUrl: 'https://cardano-preview.blockfrost.io/api/v0', projectId: blockfrostKey() },
  requestTimeoutMs: 30_000,
});

export function ourWallet() {
  const w = JSON.parse(readFileSync(resolve(__dirname, '../node-buyer/wallet.json'), 'utf8')) as WalletFile;
  return { address: w.address, signTx: createSignTx(w.privateKeyHex) };
}

const CF_WALLET = resolve(__dirname, 'cf-wallet.json');

export function cfMnemonic(): string {
  if (!existsSync(CF_WALLET)) {
    writeFileSync(CF_WALLET, JSON.stringify({ mnemonic: generateMnemonic(wordlist, 256) }, null, 2) + '\n');
  }
  return (JSON.parse(readFileSync(CF_WALLET, 'utf8')) as { mnemonic: string }).mnemonic;
}

export function cfClientSigner() {
  return toClientCardanoSigner({ mnemonic: cfMnemonic(), network: NETWORK, provider: cfProvider() });
}
