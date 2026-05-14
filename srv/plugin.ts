/**
 * CAP plugin registration for `@odatano/x402`.
 *
 * Unlike `@odatano/core`, this plugin doesn't auto-serve any CDS
 * entities — x402 is a library, not a service. We use the
 * `cds.on('served')` hook only to initialise the bridge (warm up the
 * @odatano/core connection) and the `cds.on('shutdown')` hook to clean
 * up. Consumers wire middleware / gateService themselves inside their
 * own service init().
 *
 * NEVER throws on init failure — the plugin must not crash the host
 * CAP application. Errors are logged; calls into the bridge later
 * will fail with `BRIDGE_UNAVAILABLE`.
 */

import cds from '@sap/cds';
import * as bridge from './bridge';

const log = cds.log('x402');

cds.on('served', async () => {
  try {
    await bridge.init();
    log.info('@odatano/x402 bridge ready');
  } catch (err) {
    log.warn(
      '@odatano/x402 bridge init failed (will retry on first request):',
      (err as { message?: string })?.message ?? err,
    );
  }
});

cds.on('shutdown', async () => {
  try { await bridge.shutdown(); }
  catch (err) {
    log.warn('@odatano/x402 bridge shutdown:', (err as { message?: string })?.message ?? err);
  }
});

module.exports = {};
