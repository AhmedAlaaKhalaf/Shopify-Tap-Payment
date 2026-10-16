# Payment flows

Shopify identifies a payment by `id`, which is the idempotency key in requests, and by `gid`, which is used in mutations. Every arrow into **App** is persisted before the app responds. Every mutation is sent only after the outcome has been claimed in the database.

## Non-3DS

```mermaid
sequenceDiagram
  autonumber
  participant B as Buyer
  participant S as Shopify checkout
  participant A as App
  participant DB as Database
  participant P as Mock processor

  B->>S: Pay with card
  S->>A: POST /payment_session (id, gid, amount, encrypted card)
  A->>DB: insert PaymentSession INITIATED (no-op if id exists)
  A-->>S: 201 Created
  Note over A: background job
  A->>DB: acquire lease
  A->>P: authorize(idempotencyKey = id)
  P-->>A: approved / declined
  A->>DB: store processor result, claim outcome (once)
  alt approved
    A->>S: paymentSessionResolve(gid, networkTransactionId)
    A->>DB: INITIATED -> RESOLVED
  else declined or processor error
    A->>S: paymentSessionReject(gid, CARD_DECLINED or PROCESSING_ERROR)
    A->>DB: INITIATED -> REJECTED
  end
  S-->>B: Order confirmed / payment failed
```

## 3-D Secure

```mermaid
sequenceDiagram
  autonumber
  participant B as Buyer
  participant S as Shopify checkout
  participant A as App
  participant DB as Database
  participant P as Mock processor

  S->>A: POST /payment_session
  A->>DB: insert INITIATED
  A-->>S: 201 Created
  Note over A: background job: issuer requires a challenge
  A->>DB: create ThreeDSChallenge(token), INITIATED -> REDIRECTED_3DS
  A->>S: paymentSessionRedirect(gid, https://app/3ds/token)
  S->>B: render redirectUrl in an iframe
  B->>A: GET /3ds/token (mock ACS page)
  B->>A: POST /3ds/token (pass or fail)
  A->>DB: challenge PENDING -> PASSED or FAILED (once), store 3DS data
  alt authentication failed or expired
    A->>DB: claim REJECT
    A->>S: paymentSessionReject(AUTHENTICATION_FAILED, authentication with transStatus N)
    A->>DB: REDIRECTED_3DS -> REJECTED
    A-->>B: window.parent.location = Shopify redirect URL
  else authentication passed
    A->>DB: REDIRECTED_3DS -> CONFIRMING
    A->>S: paymentSessionConfirm(gid)
    S-->>A: nextAction.redirectUrl
    A-->>B: window.parent.location = redirectUrl
    Note over S: inventory, discounts, etc. checked
    S->>A: POST /confirm_session (confirmation_result)
    A-->>S: 200 OK
    alt confirmation_result = true
      A->>DB: CONFIRMING -> CONFIRMED
      A->>P: authorize(idempotencyKey = id)
      A->>DB: claim RESOLVE or REJECT
      A->>S: paymentSessionResolve(gid, authentication with transStatus Y)
      A->>DB: CONFIRMED -> RESOLVED
    else confirmation_result = false
      A->>DB: claim REJECT
      A->>S: paymentSessionReject(CONFIRMATION_REJECTED, authentication)
      A->>DB: CONFIRMING -> REJECTED
    end
  end
```

Shopify fails resolve or reject for a confirmed 3DS session until it has sent the confirm callback. The state machine enforces the same rule: there is no `REDIRECTED_3DS -> RESOLVED` or `CONFIRMING -> RESOLVED` edge.

## Refund

```mermaid
sequenceDiagram
  autonumber
  participant S as Shopify admin
  participant A as App
  participant DB as Database
  participant P as Mock processor

  S->>A: POST /refund_session (id, gid, payment_id, amount)
  A->>DB: insert RefundSession INITIATED (no-op if id exists)
  A-->>S: 201 Created
  A->>DB: reserve amount against payment balance (atomic)
  alt payment not RESOLVED, currency mismatch, or over balance
    A->>S: refundSessionReject(PROCESSING_ERROR, reason)
  else reserved
    A->>P: refund(idempotencyKey = id)
    alt processor ok
      A->>S: refundSessionResolve(gid)
    else processor declined
      A->>DB: release reservation
      A->>S: refundSessionReject(PROCESSING_ERROR, reason)
    end
  end
```

## Retries and duplicates (summary)

| Event | Handling |
| --- | --- |
| Shopify resends `/payment_session` with the same `id` | Stored once; returns `201`; no new work if past `INITIATED` |
| Two workers process one session | DB lease, plus a compare-and-set transition; processor call keyed by `id` |
| Resolve and reject race | `outcome` claim succeeds once; the loser sends nothing |
| Shopify GraphQL `5xx`, `429` or network error | Exponential backoff; the outcome stays claimed; recovery resends the same mutation |
| Duplicate `/confirm_session` | Ignored unless the session is `CONFIRMING` with no result recorded yet |
| Buyer double-submits the 3DS form | Challenge `PENDING -> PASSED/FAILED` is a compare-and-set; the second submit gets the stored return URL |
| Process crash after `201` | `resumeInFlightWork()` re-enqueues unfinished sessions on boot |
