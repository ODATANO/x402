# x402 browser-buyer example

CIP-30 wallet + `x402Fetch` wiring for browser-side callers of an
x402-gated API. Drop-in template you can copy into a Vite / Webpack /
plain ESM frontend.

## What it shows

1. Detecting a CIP-30 wallet (`window.cardano.{eternl,lace,nami,...}`).
2. A `PayHandler` that:
   - asks your server for an unsigned payment tx (`POST /pay/intent`),
   - signs it with `wallet.signTx(cbor, true)`,
   - returns `{ signedTxCborHex, nonceRef }` to `x402Fetch`.
3. `x402Fetch` doing the 402 → sign → retry round-trip transparently.
4. Catching `X402PaymentError` to discriminate wallet-cancel from
   chain-rejection.

## What it does NOT do

- Build the unsigned tx in the browser. That step needs to resolve
  buyer UTxOs / min-ADA / fee, which today only works server-side via
  `@odatano/core` (`buildUnsignedPaymentTx`). The example assumes you
  expose a small endpoint:

  ```http
  POST /pay/intent
  Content-Type: application/json
  { "buyer": "addr_test1...", "requirement": { /* accepts[0] */ } }

  → { "unsignedTxCborHex": "84a4...", "nonceRef": "<txHash>#<index>" }
  ```

  Implementation on the server side:

  ```typescript
  import { buildUnsignedPaymentTx } from '@odatano/x402';
  app.post('/pay/intent', async (req, res) => {
    const r = await buildUnsignedPaymentTx({
      buyerBech32: req.body.buyer,
      requirement: req.body.requirement,
    });
    res.json(r);
  });
  ```

## Run

```bash
cd examples/browser-buyer
npm run dev   # vite, serves on http://localhost:5173
```

Open `http://localhost:5173`, click **Connect wallet**, point the
**Gated endpoint** input at your running CAP / Express server (default
`http://localhost:4004/odata/v4/prices/Quotes`), click **Call endpoint**.

## CORS

If your gated server is on a different origin, it needs to allow:

- `Access-Control-Allow-Origin: <your-frontend-origin>`
- `Access-Control-Allow-Headers: PAYMENT-SIGNATURE, X-PAYMENT-GRANT, Content-Type`
- `Access-Control-Expose-Headers: X-PAYMENT-RESPONSE, X-PAYMENT-GRANT, X-PAYMENT-GRANT-EXPIRES`

Otherwise the browser will block the `PAYMENT-SIGNATURE` header from
ever being sent.
