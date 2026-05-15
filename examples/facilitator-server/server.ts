/**
 * Reference x402 facilitator server.
 *
 * Boots an Express app with `createFacilitatorRouter` mounted at /v1.
 * Resource servers running `@odatano/x402` point at this URL via
 * `httpFacilitator({ url: '...', apiKey: '...' })`.
 *
 * Configuration (env):
 *   PORT                   listen port (default 4040)
 *   FACILITATOR_API_KEY    bearer token required on /v1/verify-settle.
 *                          /v1/healthz is always open.
 *   BLOCKFROST_API_KEY     consumed by @odatano/core, configured in
 *                          package.json under cds.requires.odatano-core
 *
 * Start: `BLOCKFROST_API_KEY=preprod... FACILITATOR_API_KEY=secret npm start`
 */

import express from 'express';
import { createFacilitatorRouter } from '@odatano/x402';

const PORT      = Number(process.env.PORT ?? 4040);
const API_KEY   = process.env.FACILITATOR_API_KEY;

if (!API_KEY) {
  // eslint-disable-next-line no-console
  console.warn('[facilitator] FACILITATOR_API_KEY unset, /verify-settle is OPEN.');
}

const app = express();

app.use('/v1', createFacilitatorRouter({
  auth: API_KEY
    ? (req) => req.headers.authorization === `Bearer ${API_KEY}`
    : undefined,
  onRejected: (r) => {
    // eslint-disable-next-line no-console
    console.log('[facilitator] rejected', r.code, r.reason);
  },
  onPending: (r) => {
    // eslint-disable-next-line no-console
    console.log('[facilitator] pending', r.code, r.txHash ?? '');
  },
}));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[facilitator] listening on http://127.0.0.1:${PORT}/v1`);
});
