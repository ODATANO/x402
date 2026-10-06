/**
 * Reference x402 facilitator server.
 *
 * Boots an Express app with `createFacilitatorRouter` mounted at /v1:
 * the x402 v2 facilitator API (`POST /verify`, `POST /settle`,
 * `GET /supported`). Resource servers point at it with
 * `httpFacilitator({ url: '...', apiKey: '...' })`, or any other x402 v2
 * client.
 *
 * Configuration (env):
 *   PORT                   listen port (default 4040)
 *   FACILITATOR_API_KEY    bearer token required on /v1/verify and /v1/settle.
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
  console.warn('[facilitator] FACILITATOR_API_KEY unset, /verify and /settle are OPEN.');
}

const app = express();

app.use('/v1', createFacilitatorRouter({
  auth: API_KEY
    ? (req) => req.headers.authorization === `Bearer ${API_KEY}`
    : undefined,
  onSettle: (r) => {
    // eslint-disable-next-line no-console
    console.log('[facilitator] settle', r.success ? 'ok' : r.errorReason, r.transaction);
  },
}));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[facilitator] listening on http://127.0.0.1:${PORT}/v1`);
});
