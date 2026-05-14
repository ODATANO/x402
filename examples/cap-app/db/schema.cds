namespace example;
using { cuid, managed } from '@sap/cds/common';

/**
 * A handful of fake stock-style quotes. Gated behind x402 in the
 * service layer — paying buyers can read; free callers get 402.
 */
entity Quotes : cuid, managed {
  pair      : String(20);       // e.g. 'ADA-USD'
  bid       : Decimal(15, 6);
  ask       : Decimal(15, 6);
  timestamp : Timestamp;
}

/**
 * Server self-health. Always free — the bypass regex in the
 * middleware lets root paths through, and we use a `@readonly`
 * projection that the gate skips by name.
 */
entity Health : cuid {
  status  : String(10);
  uptime  : Integer;
}
