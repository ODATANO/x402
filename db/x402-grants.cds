/**
 * Time-limited access grants issued after an accepted x402 payment.
 *
 * Pattern: pay once, get N seconds of free access to the same route.
 * The server issues an opaque random token on `accepted`, returns it via
 * the `X-PAYMENT-GRANT` response header, and the buyer presents it on
 * subsequent requests via `X-PAYMENT-GRANT` request header. Until the
 * grant expires, the gate skips the 402 + verify+settle pipeline.
 *
 * Replay defense: each grant is single-route + time-bound. A grant
 * issued for `/Quotes` cannot be used against `/getBestPrice` (cheap
 * route boundary, the picker enforces equality). Stolen tokens are
 * useful only until expiry.
 *
 * Cleanup: expired rows accumulate. The `lookupGrant` helper checks
 * `expiresAt < now` and reports `expired`; consumers may run their own
 * cleanup (`DELETE … WHERE expiresAt < now()`) on whatever schedule
 * fits. The library does NOT auto-prune.
 */

namespace odatano.x402;

entity X402Grants {
    key id         : UUID;

    @description: 'Opaque random token, base64url 32 bytes.'
        token      : String(64) @assert.unique;

    @description: 'Resource URL this grant unlocks (exact match).'
        route      : String(500);

    @description: 'Sender address from the original payment (if resolved).'
        payerAddr  : String(120);

    @description: 'Tx hash of the payment that bought this grant.'
        txHash     : String(64);

    @description: 'Asset of the underlying payment, audit only.'
        asset      : String(120);

    @description: 'cardano:mainnet | cardano:preprod | cardano:preview.'
        network    : String(20);

    @description: 'Server-side timestamp at issue.'
        issuedAt   : Timestamp;

    @description: 'Server-side timestamp when the grant becomes invalid.'
        expiresAt  : Timestamp;
}
