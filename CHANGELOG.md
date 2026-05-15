# Changelog

All notable changes to `@odatano/x402` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to [Semantic Versioning](https://semver.org/).

**Pre-1.0 caveat:** minor versions may include breaking changes until `1.0.0`.

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
