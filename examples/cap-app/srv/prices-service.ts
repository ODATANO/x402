/**
 * Example PricesService wiring @odatano/x402 into a CAP application.
 *
 * Two gated reads (Quotes, getBestPrice) and one free read (Health).
 * Demonstrates:
 *   - Plugin auto-discovery from node_modules (no cds-plugin imports here)
 *   - gateService() registering a single before('*') handler
 *   - routePricing keyed by CAP event name (entity OR action)
 *   - onAccepted callback for consumer-side audit
 *   - PaymentClaim available on req.payment after acceptance
 */

import cds from '@sap/cds';
import { gateService, type PaymentClaim } from '@odatano/x402';

// Demo wallet — replace with your own preprod addr_test1...
const PAY_TO = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

export class PricesService extends cds.ApplicationService {
  async init() {
    const log = cds.log('example');

    // x402 gate — Quotes (CRUD read) + getBestPrice (action) are priced;
    // Health is absent from routePricing so it passes through.
    gateService(this, {
      payTo:   PAY_TO,
      network: 'cardano:preprod',
      asset:   'lovelace',
      routePricing: {
        Quotes:        '500000',    // 0.5 ADA
        getBestPrice:  '1000000',   // 1 ADA
      },
      description: 'Example: synthetic price feed',
      onAccepted: (claim: PaymentClaim, req) => {
        log.info(
          `paid ${claim.amountUnits} ${claim.asset} for ${claim.resourceUrl}`,
          `(tx=${claim.txHash.slice(0, 12)}…)`,
          `event=${req.event}`,
        );
      },
    });

    // Action handler — runs only AFTER x402 gate accepted the payment.
    this.on('getBestPrice', (req) => {
      const pair = (req.data as { pair?: string }).pair ?? 'ADA-USD';
      // Synthetic — a real feed would query upstream.
      return {
        pair,
        price: 0.4125,
        timestamp: new Date().toISOString(),
      };
    });

    return super.init();
  }
}
