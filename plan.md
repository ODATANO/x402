# @odatano/x402 — Extraction & Integration Plan

**Status:** plan-only (2026-05-13). Build happens in a separate repo.
**Goal:** Extract CHAINFEED's x402 implementation into a standalone npm package `@odatano/x402` (v2-spec from scratch), then integrate it back into CHAINFEED, replacing the current v1 in-tree implementation.

---

## Locked Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Package name | `@odatano/x402` | Stays in `@odatano` org alongside `core` + `watch` |
| 2 | Spec version | **v2 from scratch** (Cardano-x402-v2) | CHAINFEED's current v1 is outdated; new project starts right |
| 3 | Deploy form | **Library-first**, standalone-deployable optional | Primary use: CHAINFEED + ODATAPAY import as lib |
| 4 | Bridge wiring | Direct import from `@odatano/core` | No DI; new project depends on core as peer |
| 5 | Audit storage | **CHAINFEED-side via `onAccepted` callback** | Plugin stays lean, CHAINFEED keeps domain-specific FeedReads schema |
| 6 | Asset coverage | **Asset-agnostic** (no USDM default) | Maximum reusability; consumer configures policy+name+decimals |
| 7 | Replay defense | **UTxO-ref nonce** (v2-spec native) | On-chain — no DB table needed |
| 8 | MVP `assetTransferMethod` | `default` only | masumi + script in later phases |

---

## Architecture (target state)

```
       @odatano/core   (Cardano OData bridge)
              ▲
              │ depends
        ┌─────┴─────┐
        │           │
   @odatano/x402    │
        ▲           │
        │ depends   │
   ┌────┴────┐  ┌───┴────┐
   │ODATAPAY │  │CHAINFEED│
   └─────────┘  └────────┘
```

CHAINFEED imports `x402Middleware`, `verifyConfirmedPayment`, `buildPaymentRequirements`, `buildUnsignedPaymentTx` from `@odatano/x402` and wires them into its CAP service. The plugin uses `@odatano/core`'s bridge methods internally.

---

## Spec v2 — Implementation-Relevant Differences from CHAINFEED's v1

### Envelope
- **Header:** `PAYMENT-SIGNATURE` (not `X-PAYMENT`)
- **Version:** `x402Version: 2` (not 1)
- **Network:** `cardano:mainnet | cardano:preprod | cardano:preview` — **colon separator**

### PaymentRequirements body
```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "cardano:preprod",
    "asset": "16a55b2a...ddde.0014df105553444d",
    "amount": "1000000",
    "payTo": "addr_test1...",
    "resource": {
      "url": "https://api.example.com/...",
      "description": "...",
      "mimeType": "application/json"
    },
    "assetTransferMethod": "default",
    "maxTimeoutSeconds": 600
  }]
}
```

Key shape changes vs v1:
- `asset` is a single string `${policyId}.${assetNameHex}` (no separate `extra.assetNameHex`)
- `amount` (not `maxAmountRequired`)
- `resource` is an object (not a string)
- `assetTransferMethod` is new

### Nonce (CRITICAL — biggest architectural change)
- **v1:** DB table `chainfeed.X402PaymentNonces` with UNIQUE on `txHash`
- **v2:** `payload.nonce = "txHash#index"` referencing a UTxO. That UTxO **must appear as an input of the payment tx**. Once the tx settles, the UTxO is consumed → cannot be reused. Replay-defense is **on-chain, no DB needed.**
- **Implication:** `@odatano/x402` doesn't ship a CDS entity for nonces. The facilitator's nonce check is `bridge.isUtxoUnspent(txHash, index) && tx.inputs.includes({txHash, index})`.

### Six Mandatory Facilitator Checks
1. **Network validation** — `header.network === requirements.network`
2. **Recipient verification** — at least one output to `payTo`
3. **Amount verification** — sum of outputs to `payTo` for `asset` ≥ required
4. **Asset verification** — exact policy + name match
5. **Nonce / replay prevention** — referenced UTxO is unspent AND appears as tx input
6. **TTL / expiry** — `tx.validity_range.upper_bound` still in future

### Confirmation Policy
- v2 spec: `mempool` status is **explicitly discouraged for real economic value**. Cardano's Ouroboros Praos has probabilistic finality.
- Only `confirmed` (first chain sighting) grants access. Matches CHAINFEED's current behavior — keep.

---

## Project Layout (new repo)

```
@odatano/x402/
├── package.json
├── tsconfig.json
├── cds-plugin.js                  → require('./srv/plugin')   (optional, for CAP use)
├── srv/
│   ├── plugin.ts                  → exports init + middleware factories
│   ├── index.ts                   → public API barrel
│   ├── core/
│   │   ├── types.ts               → v2 PaymentRequirements, PaymentEnvelope, etc.
│   │   ├── decode.ts              → PAYMENT-SIGNATURE → DecodedPayment
│   │   ├── validate.ts            → 6 mandatory checks (pure fn)
│   │   ├── requirements.ts        → v2 body builder
│   │   └── errors.ts              → masumi codes + v2 additions
│   ├── facilitator/
│   │   ├── verify.ts              → orchestrator (decode+validate+nonce+settle)
│   │   ├── settle.ts              → submit + poll-until-confirmed
│   │   └── nonce.ts               → UTxO-ref check via bridge.isUtxoUnspent
│   ├── middleware/
│   │   ├── express.ts             → RequestHandler factory
│   │   └── cap.ts                 → CAP req-handler wrapper (Phase 2)
│   ├── helpers/
│   │   ├── build-unsigned-tx.ts   → server-side coin selection, browser-side sign
│   │   └── verify-confirmed.ts    → post-paid / subscription flow
│   └── bridge.ts                  → thin re-export of @odatano/core methods
├── docs/
│   ├── api.md
│   ├── migration-from-v1.md       → for CHAINFEED migration
│   └── spec-v2-summary.md         → relevant excerpts of Cardano-x402-v2
└── test/
    ├── decode.test.ts
    ├── validate.test.ts
    ├── nonce.test.ts
    ├── settle.test.ts
    ├── verify.test.ts
    └── integration.test.ts        → end-to-end with mocked bridge
```

---

## Bridge Surface Required from @odatano/core

The new package needs these methods (most already exist on `getCardanoClient()`):

```ts
interface OdatanoCoreClientNeeds {
  submitTransaction(cborHex: string): Promise<string>;
  getTransactionByHash(hash: string): Promise<TxLite | null>;
  getUtxosAtAddress(addr: string): Promise<UtxoLite[]>;
  getProtocolParameters(): Promise<ProtoParams>;
  // NEW for v2 — verify ODATANO already exposes these:
  isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean>;
  parseTransaction(cborHex: string): Promise<ParsedTx>;  // per ODATAPAY: already shipped
  getCurrentSlot(): Promise<number>;                      // for TTL check
}
```

**Action item before starting:** verify `isUtxoUnspent` and `getCurrentSlot` are exposed by `@odatano/core` 1.7.7. If not, file as feature requests to ODATANO first (small additions — both are thin wrappers over existing Blockfrost/Koios endpoints).

---

## Public API Surface

```ts
import {
  x402Middleware,
  verifyConfirmedPayment,
  buildPaymentRequirements,
  buildUnsignedPaymentTx,
  type PaymentClaim,
  type X402Code,
  type PaymentRequirementsBody,
} from '@odatano/x402';

// 1. Mount as Express middleware
app.use('/api/premium', x402Middleware({
  payTo: 'addr_test1...',
  network: 'cardano:preprod',
  asset: '16a55b...ddde.0014df105553444d',  // policyId.nameHex single string
  decimals: 6,
  pricing: { route: { 'getBestPrice': '10000', 'getAuditPack': '50000' } },
  resourceDescription: 'CHAINFEED oracle data',
  onAccepted: async (claim) => { /* write to CHAINFEED's FeedReads */ },
}));

// 2. Post-paid / subscription verification
const result = await verifyConfirmedPayment({
  txHash, requiredUnits, asset, payTo, network,
});

// 3. Browser-buyer helper — build unsigned tx
const { unsignedTxCborHex, txHashHex } = await buildUnsignedPaymentTx({
  buyerBech32,
  requirements: paymentRequirements,
});

// 4. Build the 402 body manually (rarely needed)
const body = buildPaymentRequirements({
  amount: '10000',
  resource: { url: 'https://...', description: '...', mimeType: 'application/json' },
  asset: '...',
  payTo: 'addr_test1...',
  network: 'cardano:preprod',
});
```

---

## Phased Implementation (in new repo)

| Phase | Scope | Effort |
|---|---|---|
| **0 — Scaffold** | New repo, `package.json` (peer-dep `@odatano/core`), tsconfig, jest, eslint, cds-plugin.js stub | ½ day |
| **1 — Core v2** | `types.ts`, `decode.ts`, `validate.ts` (6 checks), `requirements.ts`, `errors.ts` | 1 day |
| **2 — Facilitator** | `nonce.ts` (UTxO-ref check), `settle.ts` (port from CHAINFEED, drop mempool option), `verify.ts` orchestrator | 1 day |
| **3 — Helpers** | `buildUnsignedPaymentTx` (port + adjust to v2 requirements shape), `verifyConfirmedPayment` (simplified, no DB nonce) | ½ day |
| **4 — Middleware** | `express.ts` factory with v2 header names + 402 body | ½ day |
| **5 — Tests** | Unit (decode/validate/nonce/settle), integration with mocked bridge, optional live smoke vs preprod | 1 day |
| **6 — Publish** | README, docs/api.md, docs/migration-from-v1.md, `npm publish @odatano/x402@0.1.0` | ½ day |
| **Total** | | **~5 days** |

---