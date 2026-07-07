# Changelog

All notable changes to `@odatano/x402` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to [Semantic Versioning](https://semver.org/).

**Pre-1.0 caveat:** minor versions may include breaking changes until `1.0.0`.

## [0.5.0] - 2026-07-07

### Added
- **Settlement-pending handling in the clients.** `x402Fetch` and `x402Axios` now re-send the SAME `PAYMENT-SIGNATURE` when the server answers `402` with `pending: true` (payment submitted but not yet indexed), instead of giving up after the buyer already paid. New options `pendingRetries` (default 5) and `pendingRetryDelayMs` (default 2000); the pay handler is never re-invoked for pending re-sends. New `X402PaymentError` kind **`settlement_pending`** signals "you HAVE paid, retry later, do not pay again" (union extension, exhaustive `switch`es on `X402PaymentErrorKind` need a new case).
- **Check-5 grace window for pending retries** (`pendingGraceMs`, default 300 000 ms, `0` disables; available on `gateService`, `x402Middleware`, `ProcessArgs`, the facilitator adapter and the HTTP-facilitator wire). A re-send arriving after the payment tx got indexed used to be rejected `replay_detected` forever: the nonce was spent by the buyer's own payment. Now, if the envelope's own tx is on chain and its server-observed `blockTime` is within the window, the request is accepted. Deliberate trade-off documented in `docs/protocol.md`: inside the window the same envelope is re-servable (an implicit mini-grant); `onAccepted` and the receipts INSERT can fire more than once per payment, so audit callbacks must be idempotent on `claim.txHash`. Anchored on server-observed block time, not the buyer-controlled TTL; if the backend reports no `blockTime`, REPLAY stands.
- **Examples:** `examples/node-buyer` (headless buyer: local key + `x402Fetch`, full 402 → pay → 200 round-trip), `examples/agent-buyer` (MCP server exposing `get_offer`/`buy_data`/`wallet_status` so AI agents buy autonomously under a server-enforced budget), and a one-command demo (`npm run demo`). `examples/cap-app` grew multi-accept pricing (ADA or a native asset via `X402_TOKEN_ASSET`), `receipts: true`, and a free `Settlements` projection.
- **Use-case docs:** `docs/use-cases/pay-per-query.md` and `docs/use-cases/ai-agent-payments.md`; README now leads with them.

### Fixed
- **`encodePaymentEnvelope` is browser-safe.** The encoder used Node's `Buffer` unconditionally, which broke in browser bundles (Vite ships no polyfill). It now uses `Buffer` where available and falls back to `btoa`/`TextEncoder`. `examples/browser-buyer` also deep-imports the pure client modules instead of the package barrel (the barrel re-exports the server side and dragged `@sap/cds`/express into the bundle), and builds on Vite 8.
- **Example prices cleared Cardano's min-UTxO.** Lovelace prices below ~0.98 ADA are unpayable (the ledger rejects the payment output); examples and docs now price at ≥ 1 ADA and document the floor. Native-asset prices are unaffected.
- **`examples/facilitator-server` env config.** CAP does not expand `${...}` placeholders in `cds.requires`; the literal `"${BLOCKFROST_API_KEY}"` string shadowed the env var. The key now comes from the environment.

### Internal
- Dependency refresh: `@odatano/core` 1.9.4, `@sap/cds` 9.9.2, `ws` 7.5.11 (fixes 3 high-severity advisories), Vite 8 in the browser example, `npm audit` reports 0 vulnerabilities. Suite: 337 tests across 26 suites, all green; every buyer flow verified live on preview.

## [0.4.0] - 2026-06-19

### Changed (breaking)
- **Dropped the direct `@emurgo/cardano-serialization-lib-nodejs` (CSL) dependency.** x402 no longer carries a CBOR/transaction library of its own; all tx parsing and building now go through `@odatano/core`'s Buildooor stack (CSL-free since core `1.8.0`). **The `@odatano/core` peer requirement is now `>=1.9.1`** (was `>=1.7.8`). Upgrade `@odatano/core` in the same step.
- **`buildUnsignedPaymentTx` now delegates to core's tx-builder.** UTxO selection, change, min-ADA and fee are handled by core (Buildooor `keepRelevant`) instead of x402's own CSL coin-selection. Consequences: the v2 `nonceRef` is now the built tx's first input (was x402's largest-UTxO pick); the validity-range upper bound is derived from a POSIX deadline and read back from the built tx, so `ttlSlot` reflects what the builder set (and may be `null` if unset) rather than a value x402 computed. The result shape (`unsignedTxCborHex`, `txHashHex`, `requiredSignerHex`, `nonceRef`, `inputs`, `ttlSlot`) and the `BuildUnsignedTxArgs` (`buyerBech32`, `requirements`, `ttlSlotsFromNow`) are unchanged. This helper is browser-buyer convenience only; it is not on the facilitator/validation path.

### Added
- `bech32` runtime dependency, for CSL-free Shelley address introspection (`srv/helpers/address.ts`) used to derive `requiredSignerHex` and validate Base/Enterprise key-cred addresses.

### Internal
- `srv/core/decode.ts` parses via core's pure `parseTransaction`; `srv/bridge.ts` gained typed `parseTransaction` and `buildUnsignedTransfer` wrappers (single coupling point preserved).
- Test fixtures (`test/fixtures/{constants,build-tx}.ts`) rebuilt on `@harmoniclabs/buildooor` (dev-only); shared `core-parse-mock` stubs the core barrel down to its pure parser so decode-exercising suites don't load uncompiled `@cds-models` sources. Suite: 317 tests across 25 suites, all green.

## [0.3.1] - 2026-05-15

### Fixed
- **`gateService` now emits the canonical x402 v2 body on the wire** instead of CAP's OData-wrapped shape. The gate writes `httpRes.status(402).json(body)` directly when an Express response is reachable, then calls `req.reject(402, ...)` as the chain-terminator: the synchronous throw stops CAP's handler pipeline so the gated `on` handler never runs, and CAP's render attempt no-ops on `headersSent`. Non-HTTP transports (event invocations, `$batch` reuse) fall back to plain `req.reject`. Validated against `@sap/cds ^9`. Third-party x402 clients now interop with CAP-gated services without any unwrap shim. Closes the "Known issues" item from 0.3.0.

### Removed (breaking)
- **`unwrapCapEnvelope`** helper and its calls from `x402Fetch` / `x402Axios`. With the server fix above, the v2 body lands at the top level on the wire and the defensive unwrap is dead code. The export is gone; consumers who pulled it in (e.g. for wrapping the wrappers) should remove the import. **Pair the upgrade**: if you upgrade the `@odatano/x402` client to 0.3.1, upgrade the server in the same step, since 0.3.1 clients no longer unwrap a 0.3.0-style wrapped body.

### Changed
- `srv/middleware/cap.ts` , new `send402` helper and `getHttpRes` accessor; the one 402 emit site routes through `send402`. The two 500 `req.reject` paths (pricing-resolver throw, facilitator throw) are unchanged.
- Test suite: 232 tests across 21 suites. CAP middleware tests gained 3 cases (canonical-wire-shape regression, `headersSent` defensive fallback, no-`http.res` transport fallback). Client tests dropped 7 cases tied to `unwrapCapEnvelope`.

## [0.3.0] - 2026-05-15

### Added
- **`createFacilitatorRouter()`** , reference HTTP facilitator. Returns an Express `Router` exposing `POST /verify-settle`, `GET /supported`, and an open `GET /healthz` liveness probe. Composable with any auth scheme via the `auth(req)` hook; defaults to `localFacilitator()`. Facilitator-side audit hooks (`onRejected`, `onPending`) fill the gap left by `onAccepted` (which is invoked client-side by `httpFacilitator()`). See [`examples/facilitator-server/`](examples/facilitator-server/) and [`docs/facilitator-protocol.md`](docs/facilitator-protocol.md#reference-implementation).
- **Multi-accept payment options** , `routePricing` (and `priceUnits`) now accept `RouteOption[]` so a single route can offer e.g. "0.5 ADA *or* 0.1 USDM". The buyer picks one implicitly by which `(payTo, asset)` the payment tx credits; new `pickRequirement()` selector in `srv/core/validate.ts` routes the tx to the matching entry before the six strict checks run. Single-entry behaviour is bit-identical to v0.2. New builder: `buildPaymentRequirementsMulti()`.
- **Dynamic `PriceResolver`** , `routePricing` can be a function `(PricingContext) => PriceSpec | null | Promise<...>`. Returning `null` passes the request through ungated, enabling free-tier, role-based, or per-payload pricing. `PricingContext` exposes `event`, `target` (CAP), `path`/`method`/`query` (Express), and `headers`. See [`docs/usage.md`](docs/usage.md#pricespec-and-priceresolver).
- **Receipts persistence (CAP)** , new `receipts?: boolean | { entity?: string }` option on `gateService`. When set, one INSERT per accepted payment, post-settle, pre-response. Default entity `odatano.x402.X402Receipts` ships in `db/x402-receipts.cds` and is auto-discovered by CAP. INSERT failures are logged and never block the response. See [`docs/usage.md`](docs/usage.md#receipts-persistence-receipts).
- **Subscription / time-limited grants (CAP)** , new `grants?: boolean | { ttlSeconds?: number; entity?: string }` option on `gateService`. On accepted payment the gate issues an opaque token and returns it via `X-PAYMENT-GRANT` / `X-PAYMENT-GRANT-EXPIRES` response headers; subsequent requests presenting the token on `X-PAYMENT-GRANT` bypass the 402 + verify+settle pipeline until expiry. Default TTL 3600s. Grants are single-route (strict URL equality). Default entity `odatano.x402.X402Grants` ships in `db/x402-grants.cds`. DB failures during issue or lookup are swallowed: failing DB never denies a paying buyer their response. See [`docs/usage.md`](docs/usage.md#subscription--time-limited-grants-grants).
- **Typed client errors** , new `X402PaymentError` class (with `kind`, `code`, `accepts`, `httpStatus`, `serverError`, `cause` fields). Thrown by `x402Fetch` and `x402Axios` to surface payment failures. Pay-handler errors are ALWAYS wrapped (with the original on `.cause`); add `errorOnFailure: true` to opt into typed throws on unrecovered 402s instead of the previous return-the-response / re-throw-AxiosError behaviour. Helpers `parseErrorCode` and `paymentErrorFromBody` are exported for consumers wrapping the wrappers. See [`docs/usage.md`](docs/usage.md#client-side-errors-x402paymenterror).
- **Browser-buyer example** , `examples/browser-buyer/` Vite scaffold showing CIP-30 wallet + `x402Fetch` wiring. Documents the typical "unsigned-from-server, signed-by-wallet" architecture (server exposes `POST /pay/intent` via `buildUnsignedPaymentTx`; browser signs via CIP-30). Includes CORS notes for cross-origin deployments.

### Fixed
- **`x402Fetch` / `x402Axios` now interop with `gateService`** out of the box. CAP's `req.reject(402, body)` wraps the canonical v2 body inside its standard OData error envelope (`{ error: { message: "<json>", code: "402", ... } }`), so previous client wrappers saw `body.x402Version === undefined` and bailed without retrying. Both clients now defensively unwrap the OData envelope before validating shape.

### Known issues
- The CAP `gateService` still emits 402 responses wrapped in CAP's OData error envelope on the wire (because `req.reject` is the only documented abort path). Third-party x402 clients hitting a CAP-gated server will see the wrapped shape; only `@odatano/x402`'s own clients unwrap it. Direct-write-to-`req.http.res` is the planned symmetric fix but needs validation against `@sap/cds` ^9 internals; tracked for v0.3.1.
- `PaymentClaim.payTo` , verified recipient address now populated on the claim (was previously only on the requirements entry). Useful for `onAccepted` audit and receipts.

### Changed
- Test count: 177 → 236 (HTTP-server round-trips, multi-accept + dynamic-pricing across `requirements`/`validate`/`verify`/`cap`/`express`, 4 receipts cases, 5 grants cases, 13 client-error cases).
- `srv/middleware/{cap,express}.ts` now emit `accepts[]` via `buildPaymentRequirementsMulti()`; single-entry callers are unaffected (one-entry array produces a body byte-identical to v0.2).
- `srv/facilitator/verify.ts` decodes the envelope BEFORE selecting a requirements entry; multi-accept depends on knowing which `(payTo, asset)` the tx actually credited.

## [0.2.0] - 2026-05-15

### Added
- **Client helpers**: `x402Fetch`, `x402Axios`, `createBridgePayHandler`, `encodePaymentEnvelope` for symmetric server + client usage. See [`docs/usage.md`](docs/usage.md#5-client-side-auto-handle-402-x402fetch--x402axios).
- **Facilitator adapter pattern**: `Facilitator` interface, `localFacilitator()` (default, in-process via `@odatano/core`), `httpFacilitator()` for delegating verify+settle to a hosted service. HTTP wire format documented in [`docs/facilitator-protocol.md`](docs/facilitator-protocol.md).
- **`facilitator` option** on `gateService` and `x402Middleware` for swapping in the local default, an HTTP delegate, or a mock for tests.
- **GitHub Actions CI** (`.github/workflows/test.yaml`): runs lint + build + tests on Node 20.x and 22.x for every push to `main` and every pull request.

### Changed
- Test count: 144 → 177 (added 4 client suites and 2 facilitator-adapter suites).

### Notes
- `0.1.0` consumers upgrade without code changes. The new `facilitator` option defaults to the previous in-process behaviour, so existing call sites are untouched.

## [0.1.0] - 2026-05-13

### Added
- Initial release. Cardano-x402-v2 payment gating for SAP CAP and Express.
- `gateService(srv, opts)` for CAP `before('*')` integration.
- `x402Middleware(opts)` for plain Express routes.
- Facilitator pipeline: decode, validate (six mandatory checks), `checkNonceUnspent`, `settle` (submit + poll-until-confirmed), `onAccepted` audit callback.
- Helpers: `verifyConfirmedPayment` (post-paid flow), `buildUnsignedPaymentTx` (browser-buyer flow).
- CAP plugin auto-discovery via `cds-plugin.js`.
- 144 unit tests across 13 suites.

### Spec compatibility
- Implements Cardano-x402-**v2** only. v1 envelopes are rejected with `unsupported_version`; v1-style network strings (`cardano-preprod` with hyphen) are rejected with `invalid_network_format`.
- v1 and v2 facilitators cannot share a route: they use different header names (`X-PAYMENT` vs `PAYMENT-SIGNATURE`) and incompatible 402 bodies. To migrate from v1, replace the middleware in one commit; clients must upgrade simultaneously.
