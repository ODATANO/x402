using { example } from '../db/schema';

service PricesService @(path: '/odata/v4/prices') {
  @readonly entity Quotes as projection on example.Quotes;
  @readonly entity Health as projection on example.Health;

  /** Returns a synthetic best price for a pair. Gated. */
  action getBestPrice(pair: String) returns {
    pair: String;
    price: Decimal;
    timestamp: Timestamp;
  };
}
