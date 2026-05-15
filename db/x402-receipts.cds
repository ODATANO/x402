/**
 * Optional persistence for accepted x402 payments.
 *
 * Enabled per-service by setting `receipts: true` on `gateService(opts)`.
 * The gate writes one row per accepted payment, after settle confirms,
 * BEFORE the response is served. Insert failures are logged and never
 * block the response, the canonical record is on chain regardless.
 *
 * Namespace and entity name are stable, consumers can SELECT against
 * `odatano.x402.X402Receipts` directly or extend it in their own model.
 */

namespace odatano.x402;

entity X402Receipts {
    key id         : UUID;

    @description: 'Lowercase 64-char hex of the buyer''s settled payment tx.'
        txHash     : String(64) @assert.unique;

    @description: 'Sender address (first input bech32) if the facilitator resolved it.'
        payerAddr  : String(120);

    @description: 'Recipient bech32 the route required.'
        payTo      : String(120);

    @description: 'v2 asset string, ''lovelace'' or ''<policy>.<nameHex>''.'
        asset      : String(120);

    @description: 'Amount paid in raw units, BigInt-safe string.'
        amount     : String(32);

    @description: 'cardano:mainnet | cardano:preprod | cardano:preview.'
        network    : String(20);

    @description: 'Resource URL the buyer paid for (request originalUrl or cap://<event>).'
        route      : String(500);

    @description: '<txHash>#<index> of the UTxO that was the replay nonce.'
        nonceRef   : String(80);

    @description: 'Server-side timestamp when the receipt was written (post-settle).'
        at         : Timestamp;
}
