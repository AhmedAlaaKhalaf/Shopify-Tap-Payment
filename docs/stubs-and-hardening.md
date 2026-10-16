# Stubs and production hardening

## What is stubbed (honestly)

| Component | Stub | Real implementation |
| --- | --- | --- |
| **Card decryption** (`decryptCard`) | Only decodes simulator payloads: fingerprint `stub-local-dev`, base64 JSON. Real Shopify payloads return `decrypted: false`, and outcomes fall back to the billing family name. | ECIES, as [Shopify documents](https://shopify.dev/docs/apps/build/payments/credit-card/use-the-cli): select the certificate by `fingerprint`; derive the shared secret by ECDH with `ephemeral_public_key`; verify the HMAC `tag`; decrypt `encrypted_message`. This must run inside a **PCI DSS** environment, and the PAN must never leave it. |
| **Processor** (`authorize`, `refund`) | In-memory, deterministic outcomes by last 4 digits; idempotency map in memory | Tap `/v2/authorize` or `/v2/charges` and `/v2/refunds`, with the Shopify session `id` as the idempotency key. Map the processor's decline codes to `PaymentSessionStateRejectedReason`. |
| **3DS** (`/3ds/:token`) | Mock ACS page with Pass/Fail buttons; fixed `V2_2` authentication data | A real 3DS server or ACS flow (device data, method URL, CReq/CRes). Pass the real `transStatus`, `transStatusReason`, `dsTransactionId`, `version` and liability shift. Frictionless flows skip the iframe. |
| **Shopify API** (`mock-shopify/`) | Stand-in GraphQL endpoint and confirm callback | The real Payments Apps API, which requires Payments Partner approval. |
| **Capture and void** | Endpoints exist (the credit card target requires them) and reject with `PROCESSING_ERROR` | Out of scope: refund is the chosen post-auth operation. |
| **Job queue** | `setImmediate` in process, with boot recovery | A durable queue (see below) |
| **Merchant UI** | One onboarding form calling `paymentsAppConfigure` | Out of scope |

Other simplifications:

- `kind: "authorization"` sessions are resolved with `authorizationExpiresAt = created + 7 days`, but capture is rejected, so in practice merchants should use automatic capture.
- Minor-unit handling covers common 0- and 3-decimal currencies; production should use the full ISO 4217 table.
- In stub mode the stored `paymentMethod` holds simulator "ciphertext", which is only base64. With real Shopify payloads it holds Shopify's encrypted blob. See the data section below.

## Production hardening

### Reliability

- **Durable queue.** Replace `jobs.server.js` with SQS, BullMQ or Cloud Tasks. Keep the same handlers: they are already idempotent and state-guarded, so at-least-once delivery is safe.
- **Postgres** instead of SQLite, using `SELECT … FOR UPDATE` or serializable transactions for the balance reservation. Add unique constraints exactly as in the current schema.
- **Reconciliation worker.** Sweep sessions where `outcome IS NOT NULL AND finalizedAt IS NULL` (claimed but unconfirmed) and resend. Sweep sessions stuck in `REDIRECTED_3DS` or `CONFIRMING` past the challenge TTL, rejecting them as `AUTHENTICATION_FAILED` once Shopify allows it. Alert on sessions with `lastError` set from `userErrors`; those need a human.
- **Use `paymentSessionPending`** when the processor is slow or uncertain, instead of rejecting on a processor timeout.
- **Processor uncertainty.** On a processor timeout, query the processor by idempotency key before deciding. Never reject a payment that may actually have been charged.
- **Edge case worth covering:** a crash after `paymentSessionRedirect` succeeds but before `redirectSentAt` is stored. The app compensates when the buyer reaches the challenge page; the reconciler should handle buyers who never arrive.
- **Graceful shutdown.** Drain in-flight jobs before exit.

### Security

- **Verify that requests come from Shopify.** Enable and validate the mTLS client certificate Shopify presents to the session URLs ([considerations](https://shopify.dev/docs/apps/build/payments/considerations)). Today only `Shopify-Shop-Domain` is checked against installed shops.
- **Key management.** Keep certificate private keys in an HSM or a cloud KMS, inside the PCI zone, and rotate certificates. Access tokens should be encrypted at rest; Prisma stores them in plaintext.
- **Data minimization.** Never log or persist the PAN. Drop the encrypted card blob once the session is finalized, and keep only the last 4 digits, the brand and the processor token. Logs already redact `payment_method` and tokens.
- **3DS page.** The challenge token is single-use and short-lived. Also add rate limits, a strict CSP, and a binding to the buyer session.
- **Rate limiting** on all public endpoints, plus request size limits.
- **Compliance webhooks.** Implement real `customers/redact` and `shop/redact` handling, scrubbing customer JSON from sessions.

### Observability

- Ship the JSON logs to a central store, keyed by `paymentId`, `gid` and `requestId` (Shopify support asks for `Shopify-Request-Id`).
- Track metrics such as: time from 201 to finalization, mutation retry counts, `userErrors` rate, decline-reason distribution, 3DS challenge and failure rate, and the age of unfinalized sessions.
- The `AuditLog` table records every state transition and outcome claim. Export it for dispute and chargeback investigations.

### Platform

- Fill in `encryption_certificate_fingerprint` and the real URLs in the extension TOML, then deploy versions through `shopify app deploy`.
- Keep `PAYMENTS_API_VERSION` and the extension `api_version` in sync, and test new versions with the mock server first.
- Payments app review: test mode support, the `paymentsAppConfigure` onboarding, an error-free `userErrors` path, and supported countries matching the listing.
