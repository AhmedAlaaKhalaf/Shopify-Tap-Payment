import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "~/db.server";
import { PaymentState as S, Outcome } from "~/services/stateMachine.server";
import { drainJobs } from "~/services/jobs.server";
import * as processor from "~/services/mockProcessor.server";
import {
  completeChallenge,
  deliverOutcome,
  finalize,
  processPayment,
  receiveConfirmation,
  receivePaymentSession,
  schedulePaymentWork,
} from "~/services/payments.server";
import { SHOP, createFakeClient, paymentBody, resetDb } from "./helpers";

let client;
vi.mock("~/services/shopAuth.server", () => ({
  clientForShop: async () => client,
  isKnownShop: async () => true,
}));

const load = (id) => prisma.paymentSession.findUnique({ where: { id }, include: { challenge: true } });

async function receive(body) {
  const { session } = await receivePaymentSession(body, { shop: SHOP, requestId: "req-1" });
  return session;
}

describe("payment sessions", () => {
  beforeEach(async () => {
    await resetDb();
    client = createFakeClient();
  });

  it("stores a retried request once and reports it as a duplicate", async () => {
    const body = paymentBody();
    const first = await receivePaymentSession(body, { shop: SHOP });
    const results = await Promise.all([1, 2, 3].map(() => receivePaymentSession(body, { shop: SHOP })));

    expect(first.duplicate).toBe(false);
    expect(results.every((r) => r.duplicate)).toBe(true);
    expect(await prisma.paymentSession.count({ where: { id: body.id } })).toBe(1);
  });

  it("refuses a payment id that belongs to another shop", async () => {
    const body = paymentBody();
    await receive(body);
    await expect(receivePaymentSession(body, { shop: "other.myshopify.com" })).rejects.toThrow(/another shop/);
  });

  it("resolves an approved non-3DS payment exactly once", async () => {
    const s = await receive(paymentBody());
    await processPayment(s.id);
    await processPayment(s.id);

    expect(client.byMutation("resolvePayment")).toHaveLength(1);
    expect(client.byMutation("resolvePayment")[0].args[0].authentication).toBeUndefined();
    const stored = await load(s.id);
    expect(stored.state).toBe(S.RESOLVED);
    expect(stored.finalizedAt).not.toBeNull();
    expect(stored.cardLast4).toBe("4242");
  });

  it("authorizes and finalizes once when workers race on the same session", async () => {
    const authorize = vi.spyOn(processor, "authorize");
    const s = await receive(paymentBody());

    await Promise.all([processPayment(s.id), processPayment(s.id), processPayment(s.id)]);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(client.finalizations()).toHaveLength(1);
    authorize.mockRestore();
  });

  it("rejects declined cards with the processor's reason", async () => {
    const s = await receive(paymentBody({ number: "4000000000000002" }));
    await processPayment(s.id);

    const [reject] = client.byMutation("rejectPayment");
    expect(reject.args[0]).toMatchObject({ code: "CARD_DECLINED" });
    expect((await load(s.id)).state).toBe(S.REJECTED);
  });

  it("sends only one finalization when resolve and reject race", async () => {
    const s = await receive(paymentBody());
    await Promise.all([
      finalize(s, [S.INITIATED], Outcome.RESOLVE),
      finalize(s, [S.INITIATED], Outcome.REJECT, { code: "PROCESSING_ERROR" }),
    ]);
    expect(client.finalizations()).toHaveLength(1);
  });

  it("keeps the claimed outcome and resends it after Shopify was unreachable", async () => {
    const s = await receive(paymentBody());
    client.resolvePayment.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(processPayment(s.id)).rejects.toThrow("ECONNRESET");
    let stored = await load(s.id);
    expect(stored).toMatchObject({ state: S.INITIATED, outcome: Outcome.RESOLVE, finalizedAt: null, lastError: "ECONNRESET" });

    // Recovery path: resend the same outcome; nothing is re-authorized.
    await schedulePaymentWork(stored);
    await drainJobs();
    stored = await load(s.id);
    expect(stored.state).toBe(S.RESOLVED);
    expect(client.resolvePayment).toHaveBeenCalledTimes(2);
    expect(client.rejectPayment).not.toHaveBeenCalled();
  });

  it("leaves the session unfinalized for reconciliation when Shopify returns userErrors", async () => {
    const s = await receive(paymentBody());
    client.resolvePayment.mockResolvedValueOnce({ payload: {}, userErrors: [{ field: ["id"], message: "already rejected" }] });

    await processPayment(s.id);
    const stored = await load(s.id);
    expect(stored.finalizedAt).toBeNull();
    expect(stored.lastError).toContain("already rejected");
  });

  it("sends resolve with authorizationExpiresAt for authorization payments", async () => {
    const s = await receive(paymentBody({ kind: "authorization" }));
    await processPayment(s.id);
    expect(client.byMutation("resolvePayment")[0].args[0].authorizationExpiresAt).toBeDefined();
  });

  describe("3-D Secure", () => {
    async function redirected() {
      const s = await receive(paymentBody({ number: "4000000000003220" }));
      await processPayment(s.id);
      return load(s.id);
    }

    it("redirects, confirms, then resolves with authentication data", async () => {
      const s = await redirected();
      expect(s.state).toBe(S.REDIRECTED_3DS);
      expect(client.byMutation("redirectPayment")[0].args[0]).toBe(`https://app.test/3ds/${s.challenge.token}`);
      expect(client.finalizations()).toHaveLength(0);

      const result = await completeChallenge(s.challenge.token, true);
      expect(result).toEqual({ status: "confirming", redirectUrl: "https://shop.test/processing" });
      expect((await load(s.id)).state).toBe(S.CONFIRMING);
      expect(client.finalizations()).toHaveLength(0);

      await receiveConfirmation({ id: s.id, gid: s.gid, confirmation_result: true }, { shop: SHOP });
      await drainJobs();

      const [resolve] = client.byMutation("resolvePayment");
      expect(resolve.args[0].authentication.authenticationData).toMatchObject({ transStatus: "Y", version: "V2_2" });
      expect((await load(s.id)).state).toBe(S.RESOLVED);
      expect(client.calls.map((c) => c.mutation)).toEqual(["redirectPayment", "confirmPayment", "resolvePayment"]);
    });

    it("rejects with AUTHENTICATION_FAILED without calling confirm", async () => {
      const s = await redirected();
      await completeChallenge(s.challenge.token, false);

      expect(client.byMutation("confirmPayment")).toHaveLength(0);
      const [reject] = client.byMutation("rejectPayment");
      expect(reject.args[0].code).toBe("AUTHENTICATION_FAILED");
      expect(reject.args[1].authentication.authenticationData.transStatus).toBe("N");
    });

    it("rejects with CONFIRMATION_REJECTED when Shopify declines to proceed", async () => {
      const s = await redirected();
      await completeChallenge(s.challenge.token, true);
      await receiveConfirmation({ id: s.id, gid: s.gid, confirmation_result: false }, { shop: SHOP });
      await drainJobs();

      expect(client.byMutation("rejectPayment")[0].args[0].code).toBe("CONFIRMATION_REJECTED");
      expect((await load(s.id)).state).toBe(S.REJECTED);
    });

    it("ignores duplicate confirmation callbacks", async () => {
      const s = await redirected();
      await completeChallenge(s.challenge.token, true);
      const confirm = { id: s.id, gid: s.gid, confirmation_result: true };

      const results = await Promise.all([
        receiveConfirmation(confirm, { shop: SHOP }),
        receiveConfirmation(confirm, { shop: SHOP }),
      ]);
      await drainJobs();
      await receiveConfirmation(confirm, { shop: SHOP });
      await drainJobs();

      expect(results.filter((r) => r.duplicate)).toHaveLength(1);
      expect(client.finalizations()).toHaveLength(1);
    });

    it("handles a double-submitted challenge once", async () => {
      const s = await redirected();
      const results = await Promise.all([completeChallenge(s.challenge.token, true), completeChallenge(s.challenge.token, false)]);

      expect(results.filter((r) => r.status === "already_completed")).toHaveLength(1);
      expect(client.byMutation("confirmPayment").length + client.byMutation("rejectPayment").length).toBe(1);
    });

    it("treats an expired challenge as failed authentication", async () => {
      const s = await redirected();
      await prisma.threeDSChallenge.update({ where: { token: s.challenge.token }, data: { expiresAt: new Date(0) } });

      await completeChallenge(s.challenge.token, true);
      expect(client.byMutation("rejectPayment")[0].args[0].code).toBe("AUTHENTICATION_FAILED");
    });

    it("rejects if Shopify refuses the redirect", async () => {
      client.redirectPayment.mockResolvedValueOnce({ payload: {}, userErrors: [{ message: "BUYER_ALREADY_REDIRECTED_BY_SHOPIFY" }] });
      const s = await redirected();

      expect(s.state).toBe(S.REJECTED);
      const [reject] = client.byMutation("rejectPayment");
      expect(reject.args[0].code).toBe("PROCESSING_ERROR");
      expect(reject.args[1].authentication).toBeUndefined();
    });
  });

  it("can deliver an outcome repeatedly without changing the result", async () => {
    const s = await receive(paymentBody());
    await processPayment(s.id);
    await deliverOutcome(s.id);
    await deliverOutcome(s.id);
    expect(client.finalizations()).toHaveLength(1);
  });
});
