/**
 * Settlement claims shared by every instance serving x402 payments for the
 * same payees. One row per payment transaction; the primary key makes the
 * claim atomic across instances. Used by `cdsSettlementStore()`.
 */

namespace odatano.x402;

type X402SettlementState : String(12) enum { submitting; pending; settled; failed; };

entity X402Settlements {
    @description: 'Lowercase 64-char hex id of the payment transaction.'
    key txId       : String(64);

        state      : X402SettlementState not null;

    @description: 'After this time the row may be dropped; the transaction can no longer land.'
        expiresAt  : Timestamp not null;

    @description: 'While state is submitting: until when the working call holds the claim. Afterwards a retry may take over.'
        leaseUntil : Timestamp;

    @description: 'True once a backend took the transaction.'
        broadcast  : Boolean not null default false;

    @description: 'JSON of the last SettlementResponse given for this transaction.'
        response   : LargeString;
}
