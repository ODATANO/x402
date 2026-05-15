/**
 * Browser-buyer reference for @odatano/x402.
 *
 * What this shows:
 *   1. CIP-30 wallet connect (Eternl / Lace / Nami / etc.).
 *   2. A `PayHandler` that builds an unsigned payment tx server-side
 *      (POST /pay/intent), signs it via the wallet, and returns the
 *      signed CBOR + nonceRef.
 *   3. Wiring `x402Fetch` so a single `paidFetch(url)` call transparently
 *      handles the 402 -> sign -> retry round-trip.
 *
 * What this does NOT do:
 *   - Build the unsigned tx in the browser. That requires resolving
 *     buyer UTxOs + min-ADA + fee, which only the server (via
 *     `@odatano/core`) does correctly today. The example assumes you
 *     expose a small server endpoint (`POST /pay/intent`) that calls
 *     `buildUnsignedPaymentTx({ buyerBech32, requirement })` and
 *     returns `{ unsignedTxCborHex, nonceRef }`.
 */

import { x402Fetch, X402PaymentError } from '@odatano/x402';
import type { PaymentRequirementEntry } from '@odatano/x402';

// ─── CIP-30 wallet type (minimal subset we use) ──────────────────────────

interface Cip30Api {
  getChangeAddress(): Promise<string>;            // hex bech32 (raw bytes)
  getUsedAddresses(): Promise<string[]>;
  signTx(cborHex: string, partial?: boolean): Promise<string>;
}

interface Cip30Wallet {
  name?: string;
  enable(): Promise<Cip30Api>;
}

declare global {
  interface Window {
    cardano?: Record<string, Cip30Wallet | undefined>;
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const out         = $<HTMLPreElement>('#out');
const status      = $<HTMLSpanElement>('#walletStatus');
const endpointEl  = $<HTMLInputElement>('#endpoint');

function log(label: string, data: unknown): void {
  out.textContent = `${label}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`;
}

// ─── Wallet wiring ───────────────────────────────────────────────────────

let wallet: Cip30Api | null = null;
let buyerBech32: string | null = null;

async function pickWallet(): Promise<Cip30Wallet> {
  const cardano = window.cardano ?? {};
  // Prefer named wallets first, fall back to any.
  const order = ['eternl', 'lace', 'nami', 'flint', 'gerowallet', 'yoroi'];
  for (const k of order) if (cardano[k]) return cardano[k]!;
  const first = Object.values(cardano).find(Boolean);
  if (first) return first as Cip30Wallet;
  throw new Error('No CIP-30 wallet detected. Install Eternl / Lace / Nami / Flint.');
}

$<HTMLButtonElement>('#connect').onclick = async () => {
  try {
    const w = await pickWallet();
    wallet = await w.enable();
    // Used addresses come back as raw hex; the server-side builder takes
    // bech32, so most apps convert here via @emurgo/cardano-serialization-lib-browser.
    // For the demo we read the bech32 from a debug endpoint your server can expose,
    // or hard-code it.
    const used = await wallet.getUsedAddresses();
    buyerBech32 = (used[0] ?? await wallet.getChangeAddress());
    status.textContent = `connected (${w.name ?? 'wallet'})`;
    log('wallet', { name: w.name, buyerHex: buyerBech32 });
  } catch (err) {
    status.textContent = `connect failed`;
    status.classList.add('err');
    log('error', (err as Error).message);
  }
};

// ─── PayHandler: unsigned-from-server, signed-by-wallet ───────────────────

async function buildAndSign(requirement: PaymentRequirementEntry): Promise<{
  signedTxCborHex: string;
  nonceRef: string;
}> {
  if (!wallet || !buyerBech32) throw new Error('connect a wallet first');

  // Step 1: ask your server to build the unsigned tx for this requirement.
  // The server uses `buildUnsignedPaymentTx({ buyerBech32, requirement })`.
  const res = await fetch('/pay/intent', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ buyer: buyerBech32, requirement }),
  });
  if (!res.ok) {
    throw new Error(`pay-intent endpoint returned ${res.status}`);
  }
  const intent = await res.json() as {
    unsignedTxCborHex: string;
    nonceRef:          string;
  };

  // Step 2: wallet signs. `partial: true` because the wallet only signs
  // its own inputs; the unsigned CBOR carries no other witnesses.
  const signedTxCborHex = await wallet.signTx(intent.unsignedTxCborHex, true);

  return { signedTxCborHex, nonceRef: intent.nonceRef };
}

const paidFetch = x402Fetch({
  pay:            buildAndSign,
  errorOnFailure: true,
  // Optional: pick a specific accepts[] entry. Default picks the first
  // (typically ADA in this codebase's multi-accept). Switch to a token
  // entry if your wallet is funded that way:
  // selectAccepts: (a) => a.find(x => x.asset.includes('.0014df105553444d')) ?? a[0],
});

// ─── Call button ─────────────────────────────────────────────────────────

$<HTMLButtonElement>('#call').onclick = async () => {
  try {
    log('calling', endpointEl.value);
    const res = await paidFetch(endpointEl.value);
    const body = await res.text();
    log(`HTTP ${res.status}`, body);
  } catch (err) {
    if (err instanceof X402PaymentError) {
      log(`X402PaymentError (${err.kind})`, {
        code: err.code,
        serverError: err.serverError,
        accepts: err.accepts,
      });
    } else {
      log('error', (err as Error).message);
    }
  }
};
