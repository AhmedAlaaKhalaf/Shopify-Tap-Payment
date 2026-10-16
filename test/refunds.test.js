import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "~/db.server";
import { RefundState as R } from "~/services/stateMachine.server";
import { processPayment, receivePaymentSession } from "~/services/payments.server";
import { processRefund, receiveRefundSession } from "~/services/refunds.server";
import { SHOP, createFakeClient, paymentBody, refundBody, resetDb } from "./helpers";

let client;
vi.mock("~/services/shopAuth.server", () => ({
  clientForShop: async () => client,
  isKnownShop: async () => true,
}));

async function resolvedPayment(amount = "25.00") {
  const { session } = await receivePaymentSession(paymentBody({ amount }), { shop: SHOP });
  await processPayment(session.id);
  return prisma.paymentSession.findUnique({ where: { id: session.id } });
}

async function refund(payment, amount, currency) {
  const { refund: r } = await receiveRefundSession(refundBody(payment.id, amount, currency ?? payment.currency), { shop: SHOP });
  await processRefund(r.id);
  return prisma.refundSession.findUnique({ where: { id: r.id } });
}

describe("refund sessions", () => {
  beforeEach(async () => {
    await resetDb();
    client = createFakeClient();
  });

  it("resolves a partial refund and tracks the refunded balance", async () => {
    const p = await resolvedPayment("25.00");
    const r = await refund(p, "10.00");

    expect(r.state).toBe(R.RESOLVED);
    expect(client.byMutation("resolveRefund")).toHaveLength(1);
    expect((await prisma.paymentSession.findUnique({ where: { id: p.id } })).refundedMinor).toBe(1000);
  });

  it("deduplicates a retried refund request", async () => {
    const p = await resolvedPayment();
    const body = refundBody(p.id, "5.00", p.currency);

    const results = await Promise.all([1, 2, 3].map(() => receiveRefundSession(body, { shop: SHOP })));
    await Promise.all([processRefund(body.id), processRefund(body.id)]);

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(client.byMutation("resolveRefund")).toHaveLength(1);
    expect((await prisma.paymentSession.findUnique({ where: { id: p.id } })).refundedMinor).toBe(500);
  });

  it("rejects a refund that exceeds the refundable balance", async () => {
    const p = await resolvedPayment("25.00");
    await refund(p, "20.00");
    const second = await refund(p, "10.00");

    expect(second.state).toBe(R.REJECTED);
    expect(second.rejectMessage).toMatch(/refundable balance/);
    expect(client.byMutation("rejectRefund")[0].args[0]).toMatchObject({ code: "PROCESSING_ERROR" });
  });

  it("never over-refunds when refunds run concurrently", async () => {
    const p = await resolvedPayment("25.00");
    const bodies = ["15.00", "15.00", "15.00"].map((amount) => refundBody(p.id, amount, p.currency));
    await Promise.all(bodies.map((b) => receiveRefundSession(b, { shop: SHOP })));
    await Promise.all(bodies.map((b) => processRefund(b.id)));

    const refunds = await prisma.refundSession.findMany({ where: { paymentId: p.id } });
    expect(refunds.filter((r) => r.state === R.RESOLVED)).toHaveLength(1);
    expect((await prisma.paymentSession.findUnique({ where: { id: p.id } })).refundedMinor).toBe(1500);
  });

  it("releases the reserved balance when the processor declines the refund", async () => {
    const p = await resolvedPayment("25.00");
    const failed = await refund(p, "5.99");
    expect(failed.state).toBe(R.REJECTED);
    expect(failed.reservedMinor).toBe(0);

    const full = await refund(p, "25.00");
    expect(full.state).toBe(R.RESOLVED);
  });

  it("rejects refunds for payments that are not resolved", async () => {
    const { session } = await receivePaymentSession(paymentBody({ number: "4000000000000002" }), { shop: SHOP });
    await processPayment(session.id);
    const declined = await prisma.paymentSession.findUnique({ where: { id: session.id } });

    const r = await refund(declined, "1.00");
    expect(r.state).toBe(R.REJECTED);
    expect(r.rejectMessage).toMatch(/REJECTED/);
  });

  it("rejects refunds for unknown payments and currency mismatches", async () => {
    const unknown = await refund({ id: "missing", currency: "SAR" }, "1.00");
    expect(unknown.rejectMessage).toMatch(/not found/);

    const p = await resolvedPayment();
    const mismatch = await refund(p, "1.00", "USD");
    expect(mismatch.rejectMessage).toMatch(/currency/);
  });
});
