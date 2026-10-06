/**
 * Live interop checks on Cardano preview between @odatano/x402 ("ours") and
 * the @x402/cardano reference implementation ("cf"), all four directions:
 *
 *   1. cf client      → our server, default transfer
 *   2. cf client      → our server, script lock with inline datum
 *   3. our client     → cf server (cf facilitator)
 *   4. our client     → our server using the cf facilitator
 *   5. cf client      → cf server using our facilitator router
 *   6. replaying a settled PAYMENT-SIGNATURE → 402 duplicate_settlement
 *
 * Scenarios 3 and 4 fail against @x402/cardano up to at least 2.28.0: its
 * facilitator re-encodes the signed transaction before submitting it, so
 * the witnesses no longer match. Verification passes.
 *
 * Each payment is 2-3 tADA between the two wallets. Fund the cf wallet first (`npm run fund`).
 *
 *   BLOCKFROST_API_KEY=preview_... NETWORK=preview BACKENDS=blockfrost npm run check
 */

import express, { type Express } from 'express';
import type { Server } from 'http';
import { Address, Credential } from '@harmoniclabs/buildooor';
import {
  bridge,
  createBridgePayHandler,
  createFacilitatorRouter,
  encodePaymentPayload,
  httpFacilitator,
  isSettlementPending,
  localFacilitator,
  readPaymentRequired,
  readSettlement,
  x402Fetch,
  x402Middleware,
  type Facilitator,
  type PaymentExtra,
} from '@odatano/x402';
import { toFacilitatorCardanoSigner } from '@x402/cardano';
import { ExactCardanoScheme as CfClientScheme } from '@x402/cardano/exact/client';
import { ExactCardanoScheme as CfServerScheme } from '@x402/cardano/exact/server';
import { ExactCardanoScheme as CfFacilitatorScheme } from '@x402/cardano/exact/facilitator';
import { x402Facilitator } from '@x402/core/facilitator';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { NETWORK, blockfrostKey, cfClientSigner, cfProvider, ourWallet } from './wallets';

const PRICE = '2000000';
// CF test script with parameter p = 42; its hash is pinned in test/core/script-hash.test.ts.
const SCRIPT_CODE = '4d01000033222220051200120011';
const SCRIPT_HASH = '7bfdc59e675e288dc869395143d2ed2d227bd23f0663449c847f6fcc';

const servers: Server[] = [];
const listen = (app: Express, port: number) =>
  new Promise<void>(res => { servers.push(app.listen(port, () => res())); });

function ourSeller(payTo: string, facilitator: Facilitator, extra?: PaymentExtra, amount = PRICE): Express {
  const app = express();
  app.use('/api', x402Middleware({
    payTo, network: NETWORK, asset: 'lovelace', facilitator,
    priceUnits: { amount, ...(extra ? { extra } : {}) },
  }));
  app.get('/api/data', (req, res) => res.json({ ok: true, txHash: req.payment?.txHash }));
  return app;
}

function cfFacilitatorApp(): Express {
  const facilitator = new x402Facilitator();
  facilitator.register(NETWORK, new CfFacilitatorScheme(
    toFacilitatorCardanoSigner({ network: NETWORK, provider: cfProvider(), awaitConfirmation: false }),
  ));
  const app = express();
  app.use(express.json());
  app.post('/verify', async (req, res) => {
    res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
  });
  app.post('/settle', async (req, res) => {
    res.json(await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements));
  });
  app.get('/supported', (_req, res) => { res.json(facilitator.getSupported()); });
  return app;
}

function cfSeller(payTo: string, facilitatorUrl: string): Express {
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }));
  server.register(NETWORK, new CfServerScheme());
  const app = express();
  app.use(paymentMiddleware({
    'GET /api/data': {
      accepts: { scheme: 'exact', network: NETWORK, payTo, price: { amount: PRICE, asset: 'lovelace' }, maxTimeoutSeconds: 600 },
      description: 'interop check',
    },
  }, server));
  app.get('/api/data', (_req, res) => { res.json({ ok: true }); });
  return app;
}

function cfFetch(): typeof fetch {
  const client = new x402Client()
    .setSpendControls({ allowedAssets: [{ network: 'cardano:*', asset: 'lovelace' }] });
  client.register('cardano:*', new CfClientScheme(cfClientSigner()));

  // The cf client does not re-send on a pending settlement, so a slow block
  // would fail the check. Remember its paid request and re-send it unchanged.
  let last: (() => Promise<Response>) | undefined;
  const recording: typeof fetch = (input, init) => {
    last = () => fetch(input instanceof Request ? input.clone() : input, init);
    return last();
  };
  const paying = wrapFetchWithPayment(recording, client);
  return async (input, init) => {
    let res = await paying(input, init);
    for (let i = 0; i < 12 && last && isSettlementPending(readSettlement(res.headers.get('PAYMENT-RESPONSE'))); i++) {
      console.log('  [check] settlement pending, re-sending the same payment');
      await new Promise(r => setTimeout(r, 10_000));
      res = await last();
    }
    return res;
  };
}

function ourFetch(): typeof fetch {
  const ours = ourWallet();
  return x402Fetch({
    pay: createBridgePayHandler({ buyerBech32: ours.address, signTx: ours.signTx }),
    errorOnFailure: true,
    pendingRetries: 10,
  });
}

let failed = 0;
async function scenario(name: string, run: () => Promise<string>): Promise<void> {
  process.stdout.write(`${name} ... `);
  try {
    console.log(`PASS ${await run()}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${(err as Error)?.message ?? err}`);
  }
}

/**
 * Wait until the provider lists an output of `txHash` at `address`. The cf
 * signer picks inputs from that list; without the wait it may reuse an
 * input the previous payment already spent.
 */
async function waitForChange(address: string, txHash: string): Promise<void> {
  const url = `https://cardano-preview.blockfrost.io/api/v0/addresses/${address}/utxos`;
  for (let i = 0; i < 60; i++) {
    const utxos = await fetch(url, { headers: { project_id: blockfrostKey() } }).then(r => r.json()) as Array<{ tx_hash: string }>;
    if (Array.isArray(utxos) && utxos.some(u => u.tx_hash === txHash)) return;
    await new Promise(r => setTimeout(r, 5_000));
  }
  throw new Error(`change of ${txHash} not visible at ${address}`);
}

async function expectPaid(res: Response): Promise<string> {
  const settled = readSettlement(res.headers.get('PAYMENT-RESPONSE'));
  if (res.status !== 200 || !settled?.success) {
    throw new Error(`HTTP ${res.status}, PAYMENT-RESPONSE ${JSON.stringify(settled)} ${(await res.text()).slice(0, 300)}`);
  }
  return `tx ${settled.transaction} (${settled.extra?.confirmations ?? '?'} conf)`;
}

/** A cf client payment, then wait until its change is spendable for the next one. */
async function cfPaid(cfAddress: string, res: Response): Promise<string> {
  const result = await expectPaid(res);
  const settled = readSettlement(res.headers.get('PAYMENT-RESPONSE'))!;
  await waitForChange(cfAddress, settled.transaction);
  return result;
}

async function main(): Promise<void> {
  const ours = ourWallet();
  const cfAddress = cfClientSigner().getAddress();
  const scriptAddress = Address.testnet(Credential.script(SCRIPT_HASH)).toString();
  // Logs why our facilitator rejected a payment; a cf server does not pass the reason on.
  const local = localFacilitator();
  const ourFacilitator: Facilitator = {
    ...local,
    verify: async (payload, requirements) => {
      const r = await local.verify(payload, requirements);
      if (!r.isValid) console.log(`  [our facilitator] verify rejected: ${r.invalidReason} ${JSON.stringify(r.extra ?? {})}`);
      return r;
    },
    settle: async (payload, requirements) => {
      const started = Date.now();
      const r = await local.settle(payload, requirements);
      if (!r.success) {
        console.log(`  [our facilitator] settle after ${Math.round((Date.now() - started) / 1000)}s: ${r.errorReason} ${JSON.stringify(r.extra ?? {})}`);
      }
      return r;
    },
  };

  await listen(ourSeller(ours.address, ourFacilitator), 4111);
  await listen(ourSeller(scriptAddress, ourFacilitator, {
    assetTransferMethod: 'script',
    script: { type: 'plutusV3', code: SCRIPT_CODE },
    parameters: { p: { type: 'bigint', value: '42' } },
    datum: 'd87981182a',
  }, '3000000'), 4112);
  await listen(cfFacilitatorApp(), 4113);
  await listen(cfSeller(cfAddress, 'http://localhost:4113'), 4114);
  await listen(ourSeller(cfAddress, httpFacilitator({ url: 'http://localhost:4113' })), 4115);
  const router = express();
  router.use(createFacilitatorRouter({ facilitator: ourFacilitator }));
  await listen(router, 4116);
  await listen(cfSeller(ours.address, 'http://localhost:4116'), 4117);

  await scenario('1 cf client -> our server (default)', async () => cfPaid(cfAddress, await cfFetch()('http://localhost:4111/api/data')));
  await scenario(`2 cf client -> our server (script ${scriptAddress.slice(0, 20)}...)`, async () =>
    cfPaid(cfAddress, await cfFetch()('http://localhost:4112/api/data')));
  await scenario('3 our client -> cf server', async () => expectPaid(await ourFetch()('http://localhost:4114/api/data')));
  await scenario('4 our client -> our server via cf facilitator', async () =>
    expectPaid(await ourFetch()('http://localhost:4115/api/data')));
  await scenario('5 cf client -> cf server via our facilitator', async () =>
    cfPaid(cfAddress, await cfFetch()('http://localhost:4117/api/data')));

  await scenario('6 replay of a settled payment', async () => {
    const url = 'http://localhost:4111/api/data';
    const required = readPaymentRequired((await fetch(url)).headers.get('PAYMENT-REQUIRED'));
    if (!required) throw new Error('no PAYMENT-REQUIRED');
    const accepted = required.accepts[0]!;
    const paid = await createBridgePayHandler({ buyerBech32: ours.address, signTx: ours.signTx })(accepted, required);
    const header = encodePaymentPayload({ paymentRequired: required, accepted, ...paid });
    const send = () => fetch(url, { headers: { 'PAYMENT-SIGNATURE': header } });
    let first = await send();
    for (let i = 0; i < 10 && readSettlement(first.headers.get('PAYMENT-RESPONSE'))?.errorReason === 'settlement_pending'; i++) {
      first = await send();
    }
    await expectPaid(first);
    const second = await send();
    const text = await second.text();
    if (second.status !== 402 || !text.includes('duplicate_settlement')) throw new Error(`HTTP ${second.status} ${text.slice(0, 200)}`);
    return 'second delivery refused with duplicate_settlement';
  });
}

main()
  .catch((err) => { failed++; console.error('setup failed:', (err as Error)?.message ?? err); })
  .finally(async () => {
    servers.forEach(s => s.close());
    await bridge.shutdown().catch(() => undefined);
    console.log(failed === 0 ? '\nall interop checks passed' : `\n${failed} interop check(s) failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
