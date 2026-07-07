/**
 * Local test wallet: a raw ed25519 key in a JSON file next to the
 * scripts. Enterprise address (payment cred only, no stake part), which
 * is all an x402 buyer needs.
 *
 * TEST NETWORKS ONLY. The key sits unencrypted on disk; never fund the
 * address with mainnet ADA.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Tx, PrivateKey } from '@harmoniclabs/buildooor';

export interface WalletFile {
  /** 32-byte ed25519 seed, hex. */
  privateKeyHex: string;
  /** Enterprise bech32 (addr_test1v...), derived from the key. */
  address: string;
}

/** Override with WALLET_FILE=/path/to/wallet.json. */
export const WALLET_PATH = resolve(process.env.WALLET_FILE ?? 'wallet.json');

export function walletExists(): boolean {
  return existsSync(WALLET_PATH);
}

export function loadWallet(): WalletFile {
  if (!walletExists()) {
    throw new Error(
      `No wallet at ${WALLET_PATH}. Run \`npm run generate-wallet\` first.`,
    );
  }
  const raw = JSON.parse(readFileSync(WALLET_PATH, 'utf8')) as WalletFile;
  if (!/^[0-9a-f]{64}$/i.test(raw.privateKeyHex ?? '') || !raw.address?.startsWith('addr')) {
    throw new Error(`${WALLET_PATH} is not a valid wallet file`);
  }
  return raw;
}

export function saveWallet(wallet: WalletFile): void {
  writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2) + '\n', 'utf8');
}

/**
 * signTx implementation for `createBridgePayHandler`: parse the unsigned
 * tx CBOR, attach a vkey witness over the body hash, re-serialize.
 * Buildooor's parse is byte-preserving, so the hash the witness signs is
 * the hash of the exact body bytes that get submitted.
 */
export function createSignTx(privateKeyHex: string): (unsignedTxCborHex: string) => Promise<string> {
  const key = new PrivateKey(Buffer.from(privateKeyHex, 'hex'));
  return async (unsignedTxCborHex: string) => {
    const tx = Tx.fromCbor(unsignedTxCborHex);
    tx.signWith(key);
    return Buffer.from(tx.toCborBytes()).toString('hex');
  };
}
