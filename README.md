# Tap Credit Card: a native Shopify payments app (case study)

A minimal backend for a **credit card payments extension** (`payments.credit-card.render`). The card is collected in Shopify checkout and authorized on-site; the buyer is not redirected to an offsite payment page.

The app:

- accepts Shopify's payment session request, persists it, and answers `201` right away;
- authorizes through a **mock processor**, with card decryption stubbed;
- finalizes each session **exactly once** with `paymentSessionResolve` or `paymentSessionReject`;
- supports **3-D Secure**: `paymentSessionRedirect`, then the challenge, then `paymentSessionConfirm`, then the confirm callback, then resolve or reject;
- implements **refund** as its one post-authorization operation;
- is idempotent on Shopify's session `id`, and emits structured JSON logs for the whole lifecycle.

Sequence diagrams: [docs/sequence-diagrams.md](docs/sequence-diagrams.md). Stubs and production hardening: [docs/stubs-and-hardening.md](docs/stubs-and-hardening.md).

## Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Post-auth operation | **Refund** | Payments are processed as `sale`, so refund is the operation every merchant needs. It also exercises the interesting cases: partial refunds, concurrent refunds, and balance limits. Void only applies to uncaptured authorizations, which needs capture support that is out of scope. |
| Shopify auth | **OAuth install**, with a **hard-coded token** fallback | Real shops install with OAuth (`@shopify/shopify-app-remix`), and the offline token is stored in the `Session` table. For the simulator, or a dev store with a manually issued token, set `SHOPIFY_ACCESS_TOKEN` and list the shop in `STATIC_SHOPS`. The offline OAuth token always wins when present. |
| Async processing | 2xx first, then in-process jobs | Shopify retries slow or failing endpoints, so the routes only validate and persist. Work runs on `setImmediate`, and `resumeInFlightWork()` re-enqueues unfinished sessions on boot. |
| Capture and void URLs | Required by the credit card target, so both are **stubbed** | Both endpoints accept the session (`201`) and reject it once with `PROCESSING_ERROR` and a clear merchant message. |

The project follows Shopify's [credit card payments app template](https://github.com/Shopify/example-app--payments-app-template--remix): Remix, Prisma, and the same session URL layout. It was modernized to Remix on Vite, Prisma 6 and `@shopify/shopify-app-remix` v3. The template's dashboard simulator, offsite-payment code and "resolve by last name" logic were not carried over.

## How the lifecycle is made safe

- **One state machine** ([`stateMachine.server.js`](app/services/stateMachine.server.js)). Payments move through `INITIATED -> (REDIRECTED_3DS -> CONFIRMING -> CONFIRMED) -> RESOLVED | REJECTED`. Every change is a compare-and-set inside a transaction, so a racing or repeated transition is a no-op and is audited exactly once.
- **The outcome is claimed before Shopify is told.** `outcome` (`RESOLVE` or `REJECT`) can be written only once, and only then is the mutation sent. A retry, a duplicate request or a racing worker can resend the *same* outcome, but can never flip it. Shopify also deduplicates mutations per session id.
- **The processor is called at most once per session.** A DB lease serializes workers, the processor gets `idempotencyKey = session id`, and the result is persisted before finalizing.
- **The 3DS gate.** A session in `REDIRECTED_3DS` or `CONFIRMING` cannot resolve. Resolve is allowed only after Shopify's confirm callback (`CONFIRMED`). `authentication` data is sent if and only if the redirect succeeded, as Shopify requires.
- **Retries.** GraphQL calls retry network errors, `429` and `5xx` with exponential backoff. `userErrors` are never retried; they leave the session unfinalized, with `lastError` set for reconciliation.
- **Refund balance.** A refund atomically reserves its amount against `amountMinor - refundedMinor` on the payment, and releases it if the processor declines. Concurrent refunds can never exceed the payment.

## Run it locally (no Shopify approval needed)

The Payments Apps API is limited to approved Payments Partners, and credit card extensions are an invite-only beta that requires a PCI AOC. So a dev store will not normally send payment sessions to this app. `mock-shopify/` stands in for Shopify. It enforces the documented rules: one finalization per id, the confirm gate, and authentication only after a redirect. It also POSTs the confirm callback.

```bash
npm install
cp .env.example .env          # then uncomment the simulator lines (see below)
npx prisma migrate deploy

npm run mock-shopify          # terminal 1, port 4000
npm run dev:local             # terminal 2, port 3000
npm run simulate              # terminal 3: 15 end-to-end scenarios
npm run simulate -- 3ds-pass refund   # or run selected scenarios
```

Simulator `.env`:

```dotenv
DATABASE_URL=file:./dev.sqlite
SHOPIFY_APP_URL=http://localhost:3000
SHOPIFY_PAYMENTS_GQL_URL=http://localhost:4000/{shop}/payments_apps/api/{version}/graphql.json
SHOPIFY_ACCESS_TOKEN=local-simulator-token
STATIC_SHOPS=tap-case-study.myshopify.com
```

Example output:

```
PASS  approve                      257ms
PASS  3ds-pass                     293ms
PASS  confirm-rejected             245ms
PASS  duplicate-payment-request    428ms
PASS  double-submit-challenge      588ms
PASS  shopify-503-retry            787ms
PASS  refund-over-balance          233ms
...
15/15 scenarios passed
```

You can also drive the 3DS page in a browser. Send a session with card `4000 0000 0000 3220`, then open the `redirectUrl` recorded at `http://localhost:4000/_calls`.

### Unit and integration tests

```bash
npm test     # 37 tests: transitions, races, idempotency, 3DS, refunds, retries
```

The tests use a throwaway `prisma/test.sqlite` built from the migrations, and an in-process fake of the GraphQL client.

## Test triggers (mock processor)

| Card ending / billing family name | Result |
| --- | --- |
| `4242`, `4444`, anything else | Approved, resolved |
| `0002` / `decline` | Rejected: `CARD_DECLINED` |
| `0069` | Rejected: `EXPIRED_CARD` |
| `0127` | Rejected: `INCORRECT_CVC` |
| `3220` / `3ds` | 3DS challenge (pass or fail on the mock ACS page) |
| `0119` / `error` | Processor error, rejected: `PROCESSING_ERROR` |
| Refund amount ending `.99` | Refund declined by the processor |

The family-name triggers exist because real Shopify payloads cannot be decrypted here (see the stubs doc).

## Run against a Shopify dev store

1. Become a Payments Partner and get access to credit card extensions. Then [create an encryption certificate](https://shopify.dev/docs/apps/build/payments/credit-card/use-the-cli) and put its fingerprint in `extensions/credit-card-payments/shopify.extension.toml`.
2. Run `npm run config:link` to link a Dev Dashboard app; this fills `client_id`.
3. Run `npm run dev`. Shopify CLI tunnels the app and sets `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL`. Replace `https://example.com` in the extension TOML with the tunnel URL, then run `npm run deploy`.
4. Install the app on the dev store, open `/app`, and activate. This calls `paymentsAppConfigure(ready: true)`.
5. Turn on test mode for the provider in **Settings > Payments** and check out.

## Endpoints

| Path | Caller | Response | Purpose |
| --- | --- | --- | --- |
| `POST /payment_session` | Shopify | `201` | Start a payment |
| `POST /confirm_session` | Shopify | `200` | Confirmation result after `paymentSessionConfirm` |
| `POST /refund_session` | Shopify | `201` | Refund |
| `POST /capture_session`, `/void_session` | Shopify | `201` | Stubs, rejected as unsupported |
| `GET/POST /3ds/:token` | Buyer (iframe) | HTML | Mock 3DS challenge (ACS) |
| `/auth/*`, `/app` | Merchant | HTML | OAuth install and onboarding |
| `POST /webhooks` | Shopify | `200` | `app/uninstalled` and compliance topics |

Each Shopify-facing endpoint checks `Shopify-Shop-Domain` against an installed shop (or `STATIC_SHOPS`) and returns `401` otherwise. Malformed bodies get `422`, unknown sessions `404`, and unexpected failures `500`, which makes Shopify retry.

## Logs

These are pino JSON lines with consistent fields: `event`, `shop`, `requestId`, `paymentId` or `refundId`, `gid`, `fromState`, `toState`, `outcome`, `mutation`, `attempt` and `userErrors`. Card data and tokens are redacted. Set `LOG_PRETTY=1` for human-readable output.

```json
{"event":"payment.received","paymentId":"sim_4e07…","amount":"25.00","currency":"SAR","kind":"sale"}
{"event":"state.outcome_claimed","entity":"payment","outcome":"RESOLVE"}
{"event":"graphql.mutation","mutation":"paymentSessionResolve","attempt":1,"durationMs":6,"userErrors":[]}
{"event":"state.transition","fromState":"INITIATED","toState":"RESOLVED"}
{"event":"payment.finalized","outcome":"RESOLVE","mutation":"paymentSessionResolve"}
```

## Layout

```
app/routes/            payment_session, confirm_session, refund_session, capture/void stubs, 3ds.$token, auth, onboarding
app/services/
  stateMachine.server.js       states, compare-and-set transitions, outcome claim, leases, audit
  payments.server.js           payment lifecycle, including 3DS and finalization
  refunds.server.js            refund lifecycle and balance reservation
  paymentsAppsClient.server.js Payments Apps GraphQL operations, retries
  mockProcessor.server.js      STUB card decryption and processor
  recovery.server.js           re-enqueue unfinished work on boot
extensions/credit-card-payments/shopify.extension.toml
mock-shopify/server.js   stand-in Payments Apps API, plus the confirm callback
scripts/simulate.js      end-to-end scenarios
prisma/                  schema and migrations (SQLite)
test/                    Vitest suites
```
