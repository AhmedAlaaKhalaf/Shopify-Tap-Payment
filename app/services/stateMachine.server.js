import prisma from "~/db.server";
import { logger } from "./logger.server";

export const PaymentState = Object.freeze({
  INITIATED: "INITIATED",
  REDIRECTED_3DS: "REDIRECTED_3DS",
  CONFIRMING: "CONFIRMING",
  CONFIRMED: "CONFIRMED",
  RESOLVED: "RESOLVED",
  REJECTED: "REJECTED",
});

export const RefundState = Object.freeze({
  INITIATED: "INITIATED",
  RESOLVED: "RESOLVED",
  REJECTED: "REJECTED",
});

export const Outcome = Object.freeze({ RESOLVE: "RESOLVE", REJECT: "REJECT" });

const P = PaymentState;
const EDGES = {
  payment: {
    [P.INITIATED]: [P.REDIRECTED_3DS, P.RESOLVED, P.REJECTED],
    [P.REDIRECTED_3DS]: [P.CONFIRMING, P.REJECTED],
    [P.CONFIRMING]: [P.CONFIRMED, P.REJECTED],
    [P.CONFIRMED]: [P.RESOLVED, P.REJECTED],
    [P.RESOLVED]: [],
    [P.REJECTED]: [],
  },
  refund: {
    [RefundState.INITIATED]: [RefundState.RESOLVED, RefundState.REJECTED],
    [RefundState.RESOLVED]: [],
    [RefundState.REJECTED]: [],
  },
};

const MODEL = { payment: "paymentSession", refund: "refundSession" };

export const TERMINAL_STATES = [P.RESOLVED, P.REJECTED];

export class InvalidTransitionError extends Error {}

export function canTransition(entity, from, to) {
  return EDGES[entity]?.[from]?.includes(to) ?? false;
}

function assertEdges(entity, from, to) {
  for (const state of from) {
    if (!canTransition(entity, state, to)) {
      throw new InvalidTransitionError(`${entity}: ${state} -> ${to} is not a valid transition`);
    }
  }
}

/**
 * Compare-and-set state change. Moves `id` to `to` only if it is currently in
 * one of `from` (and matches `guard`). Concurrent or repeated calls become
 * no-ops: exactly one caller gets `{ ok: true }`.
 */
export async function transition({ entity, id, from, to, data = {}, guard = {}, db = prisma }) {
  assertEdges(entity, from, to);
  const model = MODEL[entity];

  return db.$transaction(async (tx) => {
    const current = await tx[model].findUnique({ where: { id } });
    if (!current) return { ok: false, current: null };

    if (!from.includes(current.state)) {
      logger.debug({ event: "state.transition_skipped", entity, id, state: current.state, to }, "transition skipped");
      return { ok: false, current };
    }

    const { count } = await tx[model].updateMany({
      where: { id, state: current.state, ...guard },
      data: { ...data, state: to },
    });
    if (count !== 1) return { ok: false, current };

    await tx.auditLog.create({
      data: { entityType: entity, entityId: id, event: "transition", fromState: current.state, toState: to },
    });
    logger.info(
      { event: "state.transition", entity, [`${entity}Id`]: id, shop: current.shop, fromState: current.state, toState: to },
      `${entity} ${current.state} -> ${to}`,
    );

    return { ok: true, current: { ...current, ...data, state: to } };
  });
}

/**
 * Records the final decision (RESOLVE or REJECT) before telling Shopify.
 * `outcome` can be written only once, so a retry or a racing worker can never
 * flip a resolve into a reject (or the reverse).
 */
export async function claimOutcome({ entity, id, from, outcome, data = {}, db = prisma }) {
  const model = MODEL[entity];
  const { count } = await db[model].updateMany({
    where: { id, state: { in: from }, outcome: null },
    data: { ...data, outcome },
  });

  if (count === 1) {
    await db.auditLog.create({
      data: { entityType: entity, entityId: id, event: "outcome_claimed", data: JSON.stringify({ outcome, ...data }) },
    });
    logger.info({ event: "state.outcome_claimed", entity, [`${entity}Id`]: id, outcome, ...data }, `${entity} outcome ${outcome}`);
  }
  return count === 1;
}

const LEASE_MS = 30_000;

/** Short DB lease so only one worker drives a session's processor call at a time. */
export async function acquireLease(entity, id, db = prisma) {
  const now = new Date();
  const { count } = await db[MODEL[entity]].updateMany({
    where: { id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return count === 1;
}

export async function releaseLease(entity, id, db = prisma) {
  await db[MODEL[entity]].updateMany({ where: { id }, data: { lockedUntil: null } });
}

export async function audit(entity, id, event, data) {
  await prisma.auditLog.create({
    data: { entityType: entity, entityId: id, event, data: data ? JSON.stringify(data) : null },
  });
}
