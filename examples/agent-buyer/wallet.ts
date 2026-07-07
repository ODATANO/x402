/**
 * Agent wallet: raw ed25519 key in a JSON file (same format as
 * examples/node-buyer — point WALLET_FILE at its wallet.json to reuse it,
 * or run node-buyer's `npm run generate-wallet` here).
 *
 * TEST NETWORKS ONLY. The key sits unencrypted on disk.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Tx, PrivateKey } from '@harmoniclabs/buildooor';

export interface WalletFile {
  privateKeyHex: string;
  address: string;
}

export const WALLET_PATH = resolve(process.env.WALLET_FILE ?? 'wallet.json');

export function loadWallet(): WalletFile {
  if (!existsSync(WALLET_PATH)) {
    throw new Error(
      `No wallet at ${WALLET_PATH}. Generate one with examples/node-buyer (npm run generate-wallet) ` +
      `or set WALLET_FILE to an existing wallet.json.`,
    );
  }
  const raw = JSON.parse(readFileSync(WALLET_PATH, 'utf8')) as WalletFile;
  if (!/^[0-9a-f]{64}$/i.test(raw.privateKeyHex ?? '') || !raw.address?.startsWith('addr')) {
    throw new Error(`${WALLET_PATH} is not a valid wallet file`);
  }
  return raw;
}

/** Parse the unsigned tx, attach a vkey witness over the body hash, re-serialize. */
export function createSignTx(privateKeyHex: string): (unsignedTxCborHex: string) => Promise<string> {
  const key = new PrivateKey(Buffer.from(privateKeyHex, 'hex'));
  return async (unsignedTxCborHex: string) => {
    const tx = Tx.fromCbor(unsignedTxCborHex);
    tx.signWith(key);
    return Buffer.from(tx.toCborBytes()).toString('hex');
  };
}
