import { beforeEach, describe, expect, it } from "vitest";
import prisma from "~/db.server";
import {
  InvalidTransitionError,
  Outcome,
  PaymentState as S,
  canTransition,
  claimOutcome,
  transition,
} from "~/services/stateMachine.server";
import { receivePaymentSession } from "~/services/payments.server";
import { SHOP, paymentBody, resetDb } from "./helpers";

async function newSession() {
  const { session } = await receivePaymentSession(paymentBody(), { shop: SHOP });
  return session;
}

describe("payment state machine", () => {
  beforeEach(resetDb);

  it("allows only the documented edges", () => {
    expect(canTransition("payment", S.INITIATED, S.RESOLVED)).toBe(true);
    expect(canTransition("payment", S.INITIATED, S.REDIRECTED_3DS)).toBe(true);
    expect(canTransition("payment", S.REDIRECTED_3DS, S.CONFIRMING)).toBe(true);
    expect(canTransition("payment", S.CONFIRMING, S.CONFIRMED)).toBe(true);
    expect(canTransition("payment", S.CONFIRMED, S.RESOLVED)).toBe(true);

    // 3DS sessions cannot be resolved before Shopify confirms.
    expect(canTransition("payment", S.REDIRECTED_3DS, S.RESOLVED)).toBe(false);
    expect(canTransition("payment", S.CONFIRMING, S.RESOLVED)).toBe(false);
    // Terminal states are final.
    expect(canTransition("payment", S.RESOLVED, S.REJECTED)).toBe(false);
    expect(canTransition("payment", S.REJECTED, S.RESOLVED)).toBe(false);
  });

  it("throws on an invalid edge", async () => {
    const s = await newSession();
    await expect(transition({ entity: "payment", id: s.id, from: [S.REDIRECTED_3DS], to: S.RESOLVED })).rejects.toThrow(
      InvalidTransitionError,
    );
  });

  it("lets exactly one of two racing transitions win", async () => {
    const s = await newSession();
    const results = await Promise.all([
      transition({ entity: "payment", id: s.id, from: [S.INITIATED], to: S.RESOLVED }),
      transition({ entity: "payment", id: s.id, from: [S.INITIATED], to: S.REJECTED }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const audit = await prisma.auditLog.findMany({ where: { entityId: s.id, event: "transition" } });
    expect(audit).toHaveLength(1);
  });

  it("treats a repeated transition as a no-op", async () => {
    const s = await newSession();
    expect((await transition({ entity: "payment", id: s.id, from: [S.INITIATED], to: S.RESOLVED })).ok).toBe(true);
    expect((await transition({ entity: "payment", id: s.id, from: [S.INITIATED], to: S.RESOLVED })).ok).toBe(false);
  });

  it("claims an outcome only once, so RESOLVE can never flip to REJECT", async () => {
    const s = await newSession();
    const [resolve, reject] = await Promise.all([
      claimOutcome({ entity: "payment", id: s.id, from: [S.INITIATED], outcome: Outcome.RESOLVE }),
      claimOutcome({ entity: "payment", id: s.id, from: [S.INITIATED], outcome: Outcome.REJECT }),
    ]);

    expect([resolve, reject].filter(Boolean)).toHaveLength(1);
    const again = await claimOutcome({ entity: "payment", id: s.id, from: [S.INITIATED], outcome: Outcome.REJECT });
    expect(again).toBe(false);
  });
});
