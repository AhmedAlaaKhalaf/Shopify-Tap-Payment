import { randomBytes, randomUUID } from "node:crypto";
import prisma from "~/db.server";
import { logger } from "./logger.server";
import {
  Outcome,
  PaymentState as S,
  acquireLease,
  audit,
  claimOutcome,
  releaseLease,
  transition,
} from "./stateMachine.server";
import { clientForShop } from "./shopAuth.server";
import { nextActionRedirectUrl } from "./paymentsAppsClient.server";
import * as processor from "./mockProcessor.server";
import { enqueue } from "./jobs.server";
import { toMinor } from "./money";

const CHALLENGE_TTL_MS = 15 * 60_000;
const AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60_000;
const REQUIRED_FIELDS = ["id", "gid", "group", "amount", "currency", "test", "kind", "payment_method", "proposed_at"];

export class InvalidRequestError extends Error {}
export class NotFoundError extends Error {}

const paymentLog = (s) => logger.child({ paymentId: s.id, gid: s.gid, shop: s.shop });
const parseJson = (value) => (value ? JSON.parse(value) : null);
const appUrl = () => (process.env.SHOPIFY_APP_URL || "http://localhost:3000").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// 1. Shopify -> POST /payment_session
// ---------------------------------------------------------------------------

/**
 * Persists the session keyed by Shopify's `id` (the idempotency key).
 * A retried request returns the stored session instead of creating work.
 */
export async function receivePaymentSession(body, { shop, requestId }) {
  for (const field of REQUIRED_FIELDS) {
    if (body?.[field] === undefined || body?.[field] === null) throw new InvalidRequestError(`missing ${field}`);
  }
  if (!["sale", "authorization"].includes(body.kind)) throw new InvalidRequestError(`unsupported kind ${body.kind}`);
  if (body.payment_method.type !== "credit_card") throw new InvalidRequestError("payment_method must be credit_card");

  let amountMinor;
  try {
    amountMinor = toMinor(body.amount, body.currency);
  } catch (err) {
    throw new InvalidRequestError(err.message);
  }

  const existing = await prisma.paymentSession.findUnique({ where: { id: body.id } });
  if (existing) return duplicateOf(existing, shop, requestId);

  try {
    const session = await prisma.paymentSession.create({
      data: {
        id: body.id,
        gid: body.gid,
        shop,
        groupId: body.group,
        buyerSessionId: body.session_id ?? null,
        kind: body.kind,
        test: Boolean(body.test),
        amount: body.amount,
        amountMinor,
        currency: body.currency,
        proposedAt: new Date(body.proposed_at),
        paymentMethod: JSON.stringify(body.payment_method),
        customer: body.customer ? JSON.stringify(body.customer) : null,
      },
    });
    await audit("payment", session.id, "received", { requestId });
    paymentLog(session).info(
      { event: "payment.received", requestId, amount: session.amount, currency: session.currency, kind: session.kind, test: session.test },
      "payment session received",
    );
    return { session, duplicate: false };
  } catch (err) {
    if (err.code === "P2002") {
      return duplicateOf(await prisma.paymentSession.findUnique({ where: { id: body.id } }), shop, requestId);
    }
    throw err;
  }
}

function duplicateOf(existing, shop, requestId) {
  if (existing.shop !== shop) throw new InvalidRequestError("payment id already used by another shop");
  paymentLog(existing).info(
    { event: "payment.duplicate_request", requestId, state: existing.state, outcome: existing.outcome },
    "duplicate payment session request",
  );
  return { session: existing, duplicate: true };
}

/** Decides what background work (if any) a session still needs. Used by routes and boot recovery. */
export function schedulePaymentWork(s) {
  const key = `payment:${s.id}`;
  if (s.outcome && !s.finalizedAt) return enqueue(key, () => deliverOutcome(s.id));
  if (s.outcome) return;

  switch (s.state) {
    case S.INITIATED:
      return enqueue(key, () => processPayment(s.id));
    case S.REDIRECTED_3DS:
      return s.redirectSentAt ? undefined : enqueue(key, () => sendRedirect(s.id));
    case S.CONFIRMING:
      return s.buyerReturnUrl ? undefined : enqueue(key, () => confirmWithShopify(s.id));
    case S.CONFIRMED:
      return enqueue(key, () => processConfirmed(s.id));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 2. Background: authorize (non-3DS) or start a 3DS challenge
// ---------------------------------------------------------------------------

export async function processPayment(id) {
  if (!(await acquireLease("payment", id))) {
    logger.info({ event: "payment.lease_busy", paymentId: id }, "another worker is processing this payment");
    return;
  }

  try {
    const s = await prisma.paymentSession.findUnique({ where: { id } });
    if (!s || s.state !== S.INITIATED || s.outcome) return;

    const card = await decryptOrReject(s, [S.INITIATED]);
    if (!card) return;
    const customer = parseJson(s.customer);

    if (processor.requiresChallenge({ card, customer })) {
      await startChallenge(s);
      return;
    }

    const auth = await authorizeOnce(s, card, customer);
    await finalize(s, [S.INITIATED], auth.approved ? Outcome.RESOLVE : Outcome.REJECT, auth);
  } finally {
    await releaseLease("payment", id);
  }
}

async function decryptOrReject(s, from) {
  try {
    const card = processor.decryptCard(parseJson(s.paymentMethod));
    if (card.last4 !== s.cardLast4) {
      await prisma.paymentSession.update({ where: { id: s.id }, data: { cardLast4: card.last4, cardBrand: card.brand } });
    }
    return card;
  } catch (err) {
    paymentLog(s).warn({ event: "payment.decryption_failed", err: err.message }, "card decryption failed");
    await finalize(s, from, Outcome.REJECT, { code: "PROCESSING_ERROR", message: "Card data could not be decrypted" });
    return null;
  }
}

/** Calls the processor at most once per session; the result is persisted before Shopify is told. */
async function authorizeOnce(s, card, customer) {
  if (s.processorStatus) {
    return {
      approved: s.processorStatus === "approved",
      code: s.rejectCode ?? "PROCESSING_ERROR",
      message: s.rejectMessage,
      networkTransactionId: s.networkTransactionId,
    };
  }

  let result;
  try {
    result = await processor.authorize({
      idempotencyKey: s.id,
      card,
      customer,
      amountMinor: s.amountMinor,
      currency: s.currency,
    });
  } catch (err) {
    if (!(err instanceof processor.ProcessorError)) throw err;
    result = { approved: false, code: "PROCESSING_ERROR", message: err.message };
  }

  await prisma.paymentSession.update({
    where: { id: s.id },
    data: {
      processorStatus: result.approved ? "approved" : "declined",
      processorRef: result.processorRef ?? null,
      networkTransactionId: result.networkTransactionId ?? null,
      rejectCode: result.approved ? null : result.code,
      rejectMessage: result.approved ? null : (result.message ?? null),
    },
  });
  paymentLog(s).info(
    { event: "processor.authorization", approved: result.approved, code: result.code, processorRef: result.processorRef },
    "processor authorization",
  );
  return result;
}

async function startChallenge(s) {
  const existing = await prisma.threeDSChallenge.findUnique({ where: { paymentSessionId: s.id } });
  if (!existing) {
    await prisma.threeDSChallenge.create({
      data: {
        token: randomBytes(24).toString("base64url"),
        paymentSessionId: s.id,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      },
    });
  }

  const moved = await transition({
    entity: "payment",
    id: s.id,
    from: [S.INITIATED],
    to: S.REDIRECTED_3DS,
    data: { threeDSRequired: true },
  });
  if (moved.ok) await sendRedirect(s.id);
}

export async function sendRedirect(id) {
  const s = await prisma.paymentSession.findUnique({ where: { id }, include: { challenge: true } });
  if (!s || s.state !== S.REDIRECTED_3DS || s.redirectSentAt || s.outcome) return;

  const redirectUrl = `${appUrl()}/3ds/${s.challenge.token}`;
  const client = await clientForShop(s.shop);

  let result;
  try {
    result = await client.redirectPayment(s.gid, redirectUrl);
  } catch (err) {
    await prisma.paymentSession.update({ where: { id }, data: { lastError: `redirect: ${err.message}` } });
    throw err;
  }

  if (result.userErrors.length) {
    await prisma.paymentSession.update({ where: { id }, data: { lastError: JSON.stringify(result.userErrors) } });
    await finalize(s, [S.REDIRECTED_3DS], Outcome.REJECT, {
      code: "PROCESSING_ERROR",
      message: "3-D Secure redirect was refused by Shopify",
    });
    return;
  }

  await prisma.paymentSession.update({ where: { id }, data: { redirectSentAt: new Date() } });
  await audit("payment", id, "redirect_sent", { redirectUrl });
  paymentLog(s).info({ event: "payment.redirect_sent", mutation: "paymentSessionRedirect" }, "buyer sent to 3DS challenge");
}

// ---------------------------------------------------------------------------
// 3. Buyer -> /3ds/:token (mock ACS) -> paymentSessionConfirm
// ---------------------------------------------------------------------------

export async function getChallenge(token) {
  return prisma.threeDSChallenge.findUnique({ where: { token }, include: { paymentSession: true } });
}

function threeDSResult(passed) {
  return passed
    ? { authenticationFlow: "CHALLENGE", chargebackLiability: "UNKNOWN", transStatus: "Y", version: "V2_2", dsTransactionId: randomUUID() }
    : {
        authenticationFlow: "CHALLENGE",
        chargebackLiability: "MERCHANT",
        transStatus: "N",
        transStatusReason: "01",
        version: "V2_2",
        dsTransactionId: randomUUID(),
      };
}

/**
 * Called when the buyer finishes the challenge. Returns the URL the iframe
 * must send the buyer back to (Shopify's nextAction redirect URL).
 */
export async function completeChallenge(token, requestedPass) {
  const challenge = await getChallenge(token);
  if (!challenge) throw new NotFoundError("unknown challenge");

  const expired = challenge.expiresAt < new Date();
  const passed = requestedPass && !expired;

  const { count } = await prisma.threeDSChallenge.updateMany({
    where: { token, status: "PENDING" },
    data: { status: passed ? "PASSED" : "FAILED", completedAt: new Date() },
  });
  if (count === 0) {
    const s = await prisma.paymentSession.findUnique({ where: { id: challenge.paymentSessionId } });
    return { status: "already_completed", redirectUrl: s.buyerReturnUrl };
  }

  const s = await prisma.paymentSession.update({
    where: { id: challenge.paymentSessionId },
    data: {
      threeDSResult: JSON.stringify(threeDSResult(passed)),
      // The buyer reached the challenge, so the redirect succeeded even if
      // sendRedirect has not recorded it yet.
      redirectSentAt: challenge.paymentSession.redirectSentAt ?? new Date(),
    },
  });
  paymentLog(s).info({ event: "payment.3ds_completed", passed, expired }, "3DS challenge completed");

  if (!passed) {
    const res = await finalize(s, [S.REDIRECTED_3DS], Outcome.REJECT, {
      code: "AUTHENTICATION_FAILED",
      message: expired ? "3-D Secure challenge expired" : "3-D Secure authentication failed",
    });
    return { status: "failed", redirectUrl: res.redirectUrl };
  }

  const moved = await transition({ entity: "payment", id: s.id, from: [S.REDIRECTED_3DS], to: S.CONFIRMING, guard: { outcome: null } });
  if (!moved.ok) return { status: "stale", redirectUrl: moved.current?.buyerReturnUrl ?? null };

  return confirmWithShopify(s.id);
}

/** Asks Shopify whether the order can still proceed (inventory, discounts...). */
export async function confirmWithShopify(id) {
  const s = await prisma.paymentSession.findUnique({ where: { id } });
  if (!s || s.state !== S.CONFIRMING || s.outcome) return { status: "stale", redirectUrl: s?.buyerReturnUrl ?? null };

  const client = await clientForShop(s.shop);
  const { payload, userErrors } = await client.confirmPayment(s.gid);

  if (userErrors.length) {
    await prisma.paymentSession.update({ where: { id }, data: { lastError: JSON.stringify(userErrors) } });
    const res = await finalize(s, [S.CONFIRMING], Outcome.REJECT, {
      code: "PROCESSING_ERROR",
      message: "paymentSessionConfirm was refused by Shopify",
    });
    return { status: "failed", redirectUrl: res.redirectUrl };
  }

  const redirectUrl = nextActionRedirectUrl(payload);
  await prisma.paymentSession.update({ where: { id }, data: { buyerReturnUrl: redirectUrl } });
  await audit("payment", id, "confirm_sent", { redirectUrl });
  paymentLog(s).info({ event: "payment.confirm_sent", mutation: "paymentSessionConfirm" }, "awaiting Shopify confirmation");
  return { status: "confirming", redirectUrl };
}

// ---------------------------------------------------------------------------
// 4. Shopify -> POST /confirm_session
// ---------------------------------------------------------------------------

export async function receiveConfirmation(body, { shop, requestId }) {
  if (!body?.id || !body?.gid || typeof body.confirmation_result !== "boolean") {
    throw new InvalidRequestError("id, gid and boolean confirmation_result are required");
  }

  const s = await prisma.paymentSession.findUnique({ where: { id: body.id } });
  if (!s || s.shop !== shop) throw new NotFoundError("unknown payment session");

  const log = paymentLog(s).child({ requestId });
  if (s.state !== S.CONFIRMING || s.confirmationResult !== null) {
    log.info({ event: "payment.duplicate_confirmation", state: s.state }, "duplicate confirmation ignored");
    return { duplicate: true };
  }

  log.info({ event: "payment.confirmation_received", confirmationResult: body.confirmation_result }, "confirmation received");

  if (body.confirmation_result) {
    const moved = await transition({
      entity: "payment",
      id: s.id,
      from: [S.CONFIRMING],
      to: S.CONFIRMED,
      guard: { outcome: null },
      data: { confirmationResult: true },
    });
    if (moved.ok) enqueue(`payment:${s.id}`, () => processConfirmed(s.id));
    return { duplicate: !moved.ok };
  }

  const { count } = await prisma.paymentSession.updateMany({
    where: { id: s.id, state: S.CONFIRMING, confirmationResult: null },
    data: { confirmationResult: false },
  });
  if (count === 1) {
    enqueue(`payment:${s.id}`, () =>
      finalize(s, [S.CONFIRMING], Outcome.REJECT, {
        code: "CONFIRMATION_REJECTED",
        message: "Shopify rejected the payment confirmation",
      }),
    );
  }
  return { duplicate: count !== 1 };
}

/** After a positive confirmation: authorize with the processor, then finalize. */
export async function processConfirmed(id) {
  if (!(await acquireLease("payment", id))) return;
  try {
    const s = await prisma.paymentSession.findUnique({ where: { id } });
    if (!s || s.state !== S.CONFIRMED || s.outcome) return;

    const card = await decryptOrReject(s, [S.CONFIRMED]);
    if (!card) return;

    const auth = await authorizeOnce(s, card, parseJson(s.customer));
    await finalize(s, [S.CONFIRMED], auth.approved ? Outcome.RESOLVE : Outcome.REJECT, auth);
  } finally {
    await releaseLease("payment", id);
  }
}

// ---------------------------------------------------------------------------
// 5. Finalization: paymentSessionResolve / paymentSessionReject, exactly once
// ---------------------------------------------------------------------------

/**
 * Claims the outcome, then tells Shopify. If the claim is lost (a duplicate
 * or racing worker already decided), nothing is sent.
 */
export async function finalize(s, from, outcome, reason = {}) {
  const claimed = await claimOutcome({
    entity: "payment",
    id: s.id,
    from,
    outcome,
    data: outcome === Outcome.REJECT ? { rejectCode: reason.code, rejectMessage: reason.message ?? null } : {},
  });

  if (!claimed) {
    const current = await prisma.paymentSession.findUnique({ where: { id: s.id } });
    paymentLog(s).info(
      { event: "payment.finalize_skipped", attempted: outcome, outcome: current?.outcome, state: current?.state },
      "session already decided",
    );
    return { claimed: false, redirectUrl: current?.buyerReturnUrl ?? null };
  }

  return deliverOutcome(s.id);
}

/** Sends the claimed outcome to Shopify. Safe to repeat: Shopify deduplicates per session id. */
export async function deliverOutcome(id) {
  const s = await prisma.paymentSession.findUnique({ where: { id } });
  if (!s?.outcome || s.finalizedAt) return { claimed: true, redirectUrl: s?.buyerReturnUrl ?? null };

  const log = paymentLog(s);
  const client = await clientForShop(s.shop);
  // Required if and only if paymentSessionRedirect succeeded.
  const authentication = s.redirectSentAt && s.threeDSResult ? { authenticationData: parseJson(s.threeDSResult) } : undefined;

  let result;
  try {
    result =
      s.outcome === Outcome.RESOLVE
        ? await client.resolvePayment(s.gid, {
            authentication,
            networkTransactionId: s.networkTransactionId ?? undefined,
            authorizationExpiresAt:
              s.kind === "authorization" ? new Date(s.createdAt.getTime() + AUTHORIZATION_TTL_MS).toISOString() : undefined,
          })
        : await client.rejectPayment(
            s.gid,
            { code: s.rejectCode, merchantMessage: s.rejectMessage ?? undefined },
            { authentication },
          );
  } catch (err) {
    await prisma.paymentSession.update({ where: { id }, data: { lastError: err.message } });
    log.error({ event: "payment.finalize_failed", outcome: s.outcome, err: err.message }, "could not reach Shopify; will retry on recovery");
    throw err;
  }

  if (result.userErrors.length) {
    await prisma.paymentSession.update({ where: { id }, data: { lastError: JSON.stringify(result.userErrors) } });
    log.error(
      { event: "payment.finalize_refused", outcome: s.outcome, userErrors: result.userErrors },
      "Shopify refused finalization; needs manual reconciliation",
    );
    return { claimed: true, redirectUrl: s.buyerReturnUrl, userErrors: result.userErrors };
  }

  const redirectUrl = nextActionRedirectUrl(result.payload) ?? s.buyerReturnUrl;
  await transition({
    entity: "payment",
    id,
    from: [s.state],
    to: s.outcome === Outcome.RESOLVE ? S.RESOLVED : S.REJECTED,
    guard: { outcome: s.outcome, finalizedAt: null },
    data: { finalizedAt: new Date(), lastError: null, buyerReturnUrl: redirectUrl },
  });
  log.info(
    { event: "payment.finalized", outcome: s.outcome, rejectCode: s.rejectCode, mutation: s.outcome === Outcome.RESOLVE ? "paymentSessionResolve" : "paymentSessionReject" },
    `payment ${s.outcome === Outcome.RESOLVE ? "resolved" : "rejected"}`,
  );
  return { claimed: true, redirectUrl };
}
