# Changelog

All notable changes to `@odatano/x402` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to [Semantic Versioning](https://semver.org/).

**Pre-1.0 caveat:** minor versions may include breaking changes until `1.0.0`.

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
- **`x402Fetch` / `x402Axios` now interop with `gateService`** out of the box. CAP's `req.reject(402, body)` wraps the canonical v2 body inside its standard OData error envelope (`{ error: { message: "<json>", code: "402", ... } }`), so previous client wrappers saw `body.x402Version === undefined` and bailed without retrying. Both clients now defensively unwrap the OData envelope before validating shape. Reported by the CHAINFEED team; matches the workaround they were shipping in `scripts/buyer-pay-and-fetch.ts`. New helper `unwrapCapEnvelope` is exported for consumers wrapping the wrappers.

### Known issues
- The CAP `gateService` still emits 402 responses wrapped in CAP's OData error envelope on the wire (because `req.reject` is the only documented abort path). Third-party x402 clients hitting a CAP-gated server will see the wrapped shape; only `@odatano/x402`'s own clients unwrap it. Direct-write-to-`req.http.res` is the planned symmetric fix but needs validation against `@sap/cds` ^9 internals; tracked for v0.3.1.
- `PaymentClaim.payTo` , verified recipient address now populated on the claim (was previously only on the requirements entry). Useful for `onAccepted` audit and receipts.

### Changed
- Test count: 177 → 230 (HTTP-server round-trips, multi-accept + dynamic-pricing across `requirements`/`validate`/`verify`/`cap`/`express`, 4 receipts cases, 5 grants cases, 13 client-error cases).
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
