/**
 * Example PricesService: a pay-per-query data service on SAP CAP.
 *
 * The enterprise scenario: a price feed sold per request instead of
 * per API-key contract. Two gated reads (Quotes, getBestPrice), a free
 * health probe, and a free Settlements view over the persisted
 * receipts, the seller's accounting without an invoicing run.
 *
 * Demonstrates:
 *   - Plugin auto-discovery from node_modules (no cds-plugin imports here)
 *   - gateService() registering a single before('*') handler
 *   - routePricing keyed by CAP event name (entity OR action)
 *   - multi-accept pricing: pay in ADA *or* a stablecoin/native asset
 *   - receipts: true persisting one row per settled payment
 *   - onAccepted callback for consumer-side audit
 */

import cds from '@sap/cds';
import { gateService, isNetwork, type Network, type PaymentClaim } from '@odatano/x402';

// Demo wallet, replace with your own addr_test1...
const PAY_TO = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

// Advertise the same chain the backend settles on (NETWORK env, the
// same variable @odatano/core reads). Default preprod.
const NETWORK: Network = `cardano:${process.env.NETWORK ?? 'preprod'}` as Network;
if (!isNetwork(NETWORK)) throw new Error(`unsupported NETWORK "${process.env.NETWORK}"`);

// Optional second way to pay: a native asset (e.g. USDM). Set
// X402_TOKEN_ASSET to '<policyId>.<assetNameHex>' and X402_TOKEN_AMOUNT
// to the raw-unit price. Native-asset prices have no min-ADA floor,
// the payment output carries its own min-ADA on top.
const TOKEN_ASSET  = process.env.X402_TOKEN_ASSET;
const TOKEN_AMOUNT = process.env.X402_TOKEN_AMOUNT ?? '100000';

export class PricesService extends cds.ApplicationService {
  async init() {
    const log = cds.log('example');

    // x402 gate, Quotes (CRUD read) + getBestPrice (action) are priced;
    // Health and Settlements are absent from routePricing so they pass
    // through. Lovelace prices must clear Cardano's min-UTxO (~0.98 ADA
    // on current params): the payment is a real on-chain output and the
    // ledger rejects smaller ones, so 1 ADA is the practical floor.
    gateService(this, {
      payTo:   PAY_TO,
      network: NETWORK,
      asset:   'lovelace',
      routePricing: {
        // Multi-accept: buyers choose ADA or the configured token by
        // which (payTo, asset) their payment tx actually credits.
        Quotes: [
          { amount: '1000000' },                                       // 1 ADA
          ...(TOKEN_ASSET ? [{ amount: TOKEN_AMOUNT, asset: TOKEN_ASSET }] : []),
        ],
        getBestPrice:  '2000000',   // 2 ADA
      },
      // One row per settled payment into odatano.x402.X402Receipts,
      // exposed read-only as PricesService.Settlements.
      receipts: true,
      description: 'Example: synthetic price feed',
      onAccepted: (claim: PaymentClaim, req) => {
        log.info(
          `paid ${claim.amountUnits} ${claim.asset} for ${claim.resourceUrl}`,
          `(tx=${claim.txHash.slice(0, 12)}…)`,
          `event=${req.event}`,
        );
      },
    });

    // Action handler, runs only AFTER x402 gate accepted the payment.
    this.on('getBestPrice', (req) => {
      const pair = (req.data as { pair?: string }).pair ?? 'ADA-USD';
      // Synthetic, a real feed would query upstream.
      return {
        pair,
        price: 0.4125,
        timestamp: new Date().toISOString(),
      };
    });

    return super.init();
  }
}
