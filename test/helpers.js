import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import prisma from "~/db.server";
import { STUB_FINGERPRINT, resetMockProcessor } from "~/services/mockProcessor.server";

export const SHOP = "test-shop.myshopify.com";

export async function resetDb() {
  resetMockProcessor();
  await prisma.auditLog.deleteMany();
  await prisma.threeDSChallenge.deleteMany();
  await prisma.refundSession.deleteMany();
  await prisma.paymentSession.deleteMany();
  await prisma.unsupportedSession.deleteMany();
}

/** Records every mutation, like the mock Shopify server but in-process. */
export function createFakeClient() {
  const calls = [];
  const okPayment = (gid, redirectUrl = `https://shop.test/checkout/${gid}`) => ({
    payload: { paymentSession: { id: gid, nextAction: { action: "REDIRECT", context: { redirectUrl } } } },
    userErrors: [],
  });
  const record = (mutation, impl) =>
    vi.fn(async (gid, ...args) => {
      calls.push({ mutation, gid, args });
      return impl(gid, ...args);
    });

  return {
    calls,
    byMutation: (mutation) => calls.filter((c) => c.mutation === mutation),
    finalizations: () => calls.filter((c) => /^(resolve|reject)/.test(c.mutation)),
    resolvePayment: record("resolvePayment", (gid) => okPayment(gid)),
    rejectPayment: record("rejectPayment", (gid) => okPayment(gid)),
    redirectPayment: record("redirectPayment", (gid) => okPayment(gid)),
    confirmPayment: record("confirmPayment", (gid) => okPayment(gid, "https://shop.test/processing")),
    resolveRefund: record("resolveRefund", () => ({ payload: {}, userErrors: [] })),
    rejectRefund: record("rejectRefund", () => ({ payload: {}, userErrors: [] })),
    rejectCapture: record("rejectCapture", () => ({ payload: {}, userErrors: [] })),
    rejectVoid: record("rejectVoid", () => ({ payload: {}, userErrors: [] })),
  };
}

export function paymentBody({ number = "4242424242424242", amount = "25.00", currency = "SAR", kind = "sale" } = {}) {
  const id = `pay_${randomUUID().slice(0, 12)}`;
  return {
    id,
    gid: `gid://shopify/PaymentSession/${id}`,
    group: `grp_${id}`,
    amount,
    currency,
    test: true,
    kind,
    proposed_at: new Date().toISOString(),
    payment_method: {
      type: "credit_card",
      data: {
        fingerprint: STUB_FINGERPRINT,
        encrypted_message: Buffer.from(JSON.stringify({ number })).toString("base64"),
        ephemeral_public_key: "stub",
        tag: "stub",
      },
    },
    customer: { email: "buyer@example.com", billing_address: { family_name: "Smith" } },
  };
}

export function refundBody(paymentId, amount, currency = "SAR") {
  const id = `ref_${randomUUID().slice(0, 12)}`;
  return { id, gid: `gid://shopify/RefundSession/${id}`, payment_id: paymentId, amount, currency, test: true, proposed_at: new Date().toISOString() };
}
