import prisma from "~/db.server";
import { logger } from "./logger.server";
import { Outcome, PaymentState, RefundState as R, acquireLease, audit, claimOutcome, releaseLease, transition } from "./stateMachine.server";
import { clientForShop } from "./shopAuth.server";
import * as processor from "./mockProcessor.server";
import { enqueue } from "./jobs.server";
import { toMinor } from "./money";
import { InvalidRequestError } from "./payments.server";

const REQUIRED_FIELDS = ["id", "gid", "payment_id", "amount", "currency", "proposed_at"];

const refundLog = (r) => logger.child({ refundId: r.id, gid: r.gid, paymentId: r.paymentId, shop: r.shop });

// Shopify -> POST /refund_session
export async function receiveRefundSession(body, { shop, requestId }) {
  for (const field of REQUIRED_FIELDS) {
    if (body?.[field] === undefined || body?.[field] === null) throw new InvalidRequestError(`missing ${field}`);
  }

  let amountMinor;
  try {
    amountMinor = toMinor(body.amount, body.currency);
  } catch (err) {
    throw new InvalidRequestError(err.message);
  }

  const existing = await prisma.refundSession.findUnique({ where: { id: body.id } });
  if (existing) return duplicateOf(existing, shop, requestId);

  try {
    const refund = await prisma.refundSession.create({
      data: {
        id: body.id,
        gid: body.gid,
        shop,
        paymentId: body.payment_id,
        amount: body.amount,
        amountMinor,
        currency: body.currency,
        test: Boolean(body.test),
        proposedAt: new Date(body.proposed_at),
      },
    });
    await audit("refund", refund.id, "received", { requestId });
    refundLog(refund).info({ event: "refund.received", requestId, amount: refund.amount, currency: refund.currency }, "refund session received");
    return { refund, duplicate: false };
  } catch (err) {
    if (err.code === "P2002") return duplicateOf(await prisma.refundSession.findUnique({ where: { id: body.id } }), shop, requestId);
    throw err;
  }
}

function duplicateOf(existing, shop, requestId) {
  if (existing.shop !== shop) throw new InvalidRequestError("refund id already used by another shop");
  refundLog(existing).info({ event: "refund.duplicate_request", requestId, state: existing.state }, "duplicate refund session request");
  return { refund: existing, duplicate: true };
}

export function scheduleRefundWork(r) {
  const key = `refund:${r.id}`;
  if (r.outcome && !r.finalizedAt) return enqueue(key, () => deliverRefundOutcome(r.id));
  if (!r.outcome && r.state === R.INITIATED) return enqueue(key, () => processRefund(r.id));
  return undefined;
}

export async function processRefund(id) {
  if (!(await acquireLease("refund", id))) return;
  try {
    const r = await prisma.refundSession.findUnique({ where: { id } });
    if (!r || r.state !== R.INITIATED || r.outcome) return;

    const reservation = await reserveBalance(r);
    if (!reservation.ok) {
      await finalizeRefund(r, Outcome.REJECT, reservation.reason);
      return;
    }

    const result = await processor.refund({ idempotencyKey: r.id, processorRef: reservation.payment.processorRef, amount: r.amount });
    refundLog(r).info({ event: "processor.refund", ok: result.ok, refundRef: result.refundRef }, "processor refund");

    if (result.ok) {
      await prisma.refundSession.update({ where: { id }, data: { processorRef: result.refundRef } });
      await finalizeRefund(r, Outcome.RESOLVE);
    } else {
      await releaseBalance(r);
      await finalizeRefund(r, Outcome.REJECT, result.message);
    }
  } finally {
    await releaseLease("refund", id);
  }
}

/**
 * Atomically holds the refund amount against the payment's refundable
 * balance, so concurrent refunds can never exceed the captured amount.
 */
async function reserveBalance(r, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tryReserveBalance(r);
    } catch (err) {
      if (!(err instanceof BalanceConflictError) || attempt === attempts) throw err;
    }
  }
}

class BalanceConflictError extends Error {}

async function tryReserveBalance(r) {
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.refundSession.findUnique({ where: { id: r.id } });
    const payment = await tx.paymentSession.findUnique({ where: { id: r.paymentId } });

    if (fresh.reservedMinor > 0) return { ok: true, payment };
    if (!payment || payment.shop !== r.shop) return { ok: false, reason: "Original payment not found" };
    if (payment.state !== PaymentState.RESOLVED) return { ok: false, reason: `Original payment is ${payment.state}, not RESOLVED` };
    if (payment.currency !== r.currency) return { ok: false, reason: "Refund currency does not match payment currency" };

    const remaining = payment.amountMinor - payment.refundedMinor;
    if (r.amountMinor <= 0 || r.amountMinor > remaining) {
      return { ok: false, reason: `Refund exceeds refundable balance (${remaining} minor units left)` };
    }

    const { count } = await tx.paymentSession.updateMany({
      where: { id: payment.id, refundedMinor: payment.refundedMinor },
      data: { refundedMinor: { increment: r.amountMinor } },
    });
    if (count !== 1) throw new BalanceConflictError("refundable balance changed concurrently");

    await tx.refundSession.update({ where: { id: r.id }, data: { reservedMinor: r.amountMinor } });
    return { ok: true, payment };
  });
}

async function releaseBalance(r) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.refundSession.updateMany({
      where: { id: r.id, reservedMinor: r.amountMinor },
      data: { reservedMinor: 0 },
    });
    if (count === 1) {
      await tx.paymentSession.update({ where: { id: r.paymentId }, data: { refundedMinor: { decrement: r.amountMinor } } });
    }
  });
}

async function finalizeRefund(r, outcome, message) {
  const claimed = await claimOutcome({
    entity: "refund",
    id: r.id,
    from: [R.INITIATED],
    outcome,
    data: outcome === Outcome.REJECT ? { rejectCode: "PROCESSING_ERROR", rejectMessage: message ?? null } : {},
  });
  if (!claimed) {
    refundLog(r).info({ event: "refund.finalize_skipped", attempted: outcome }, "refund already decided");
    return;
  }
  await deliverRefundOutcome(r.id);
}

export async function deliverRefundOutcome(id) {
  const r = await prisma.refundSession.findUnique({ where: { id } });
  if (!r?.outcome || r.finalizedAt) return;

  const log = refundLog(r);
  const client = await clientForShop(r.shop);

  let result;
  try {
    result =
      r.outcome === Outcome.RESOLVE
        ? await client.resolveRefund(r.gid)
        : await client.rejectRefund(r.gid, { code: r.rejectCode, merchantMessage: r.rejectMessage ?? undefined });
  } catch (err) {
    await prisma.refundSession.update({ where: { id }, data: { lastError: err.message } });
    log.error({ event: "refund.finalize_failed", outcome: r.outcome, err: err.message }, "could not reach Shopify; will retry on recovery");
    throw err;
  }

  if (result.userErrors.length) {
    await prisma.refundSession.update({ where: { id }, data: { lastError: JSON.stringify(result.userErrors) } });
    log.error({ event: "refund.finalize_refused", userErrors: result.userErrors }, "Shopify refused refund finalization");
    return;
  }

  await transition({
    entity: "refund",
    id,
    from: [R.INITIATED],
    to: r.outcome === Outcome.RESOLVE ? R.RESOLVED : R.REJECTED,
    guard: { outcome: r.outcome, finalizedAt: null },
    data: { finalizedAt: new Date(), lastError: null },
  });
  log.info(
    { event: "refund.finalized", outcome: r.outcome, mutation: r.outcome === Outcome.RESOLVE ? "refundSessionResolve" : "refundSessionReject" },
    `refund ${r.outcome === Outcome.RESOLVE ? "resolved" : "rejected"}`,
  );
}
