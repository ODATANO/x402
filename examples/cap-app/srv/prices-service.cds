using { example } from '../db/schema';
using { odatano.x402 as x402 } from '@odatano/x402/db/x402-receipts';

service PricesService @(path: '/odata/v4/prices') {
  @readonly entity Quotes as projection on example.Quotes;
  @readonly entity Health as projection on example.Health;

  /**
   * Seller-side accounting view over the plugin-persisted receipts:
   * one row per settled payment (tx hash, payer, amount, route).
   * Free to read, absent from routePricing, so the gate skips it.
   */
  @readonly entity Settlements as projection on x402.X402Receipts;

  /** Returns a synthetic best price for a pair. Gated. */
  action getBestPrice(pair: String) returns {
    pair: String;
    price: Decimal;
    timestamp: Timestamp;
  };
}
