#!/usr/bin/env node
/**
 * Plays Shopify (and the buyer) against the running app, then checks which
 * mutations reached the mock Payments Apps API.
 *
 *   npm run mock-shopify      # terminal 1
 *   npm run dev:local         # terminal 2 (with SHOPIFY_PAYMENTS_GQL_URL pointing at the mock)
 *   npm run simulate          # terminal 3   (optional: npm run simulate -- 3ds-pass refund)
 */
import { randomUUID } from "node:crypto";

const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const MOCK_URL = (process.env.MOCK_URL || "http://localhost:4000").replace(/\/$/, "");
const SHOP = process.env.SIM_SHOP || "tap-case-study.myshopify.com";
const STUB_FINGERPRINT = "stub-local-dev";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function card(number) {
  const message = Buffer.from(JSON.stringify({ number, month: 12, year: 2030, name: "Alice Smith" })).toString("base64");
  return {
    type: "credit_card",
    data: { fingerprint: STUB_FINGERPRINT, encrypted_message: message, ephemeral_public_key: "stub", tag: "stub", moto: false },
  };
}

function paymentBody({ number = "4242424242424242", amount = "25.00", currency = "SAR", familyName = "Smith" } = {}) {
  const id = `sim_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return {
    id,
    gid: `gid://shopify/PaymentSession/${id}`,
    group: `grp_${id}`,
    session_id: `ses_${id}`,
    amount,
    currency,
    test: true,
    merchant_locale: "en",
    payment_method: card(number),
    proposed_at: new Date().toISOString(),
    customer: {
      email: "buyer@example.com",
      billing_address: { given_name: "Alice", family_name: familyName, line1: "King Fahd Rd", city: "Riyadh", country_code: "SA" },
    },
    kind: "sale",
  };
}

function refundBody(payment, amount) {
  const id = `ref_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  return {
    id,
    gid: `gid://shopify/RefundSession/${id}`,
    payment_id: payment.id,
    amount,
    currency: payment.currency,
    test: true,
    merchant_locale: "en",
    proposed_at: new Date().toISOString(),
  };
}

async function post(path, body, { shop = SHOP } = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Shopify-Shop-Domain": shop,
      "Shopify-Request-Id": randomUUID(),
      "Shopify-Api-Version": "2026-07",
    },
    body: JSON.stringify(body),
  });
  return res.status;
}

async function mock(path, body) {
  const res = await fetch(`${MOCK_URL}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return res.json();
}

const callsFor = (gid) => mock(`/_calls?gid=${encodeURIComponent(gid)}`);
const applied = (calls, mutation) => calls.filter((c) => c.mutation === mutation && !c.injectedFailure && !c.userErrors?.length);
const finalizations = (calls) => calls.filter((c) => /Session(Resolve|Reject)$/.test(c.mutation) && !c.injectedFailure);

async function waitFor(gid, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let calls = [];
  while (Date.now() < deadline) {
    calls = await callsFor(gid);
    if (predicate(calls)) return calls;
    await sleep(50);
  }
  throw new Error(`timed out; mutations so far: ${calls.map((c) => c.mutation).join(", ") || "none"}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Buyer side of 3DS: load the iframe URL, then submit the mock ACS form. */
async function completeChallenge(gid, intent) {
  const calls = await waitFor(gid, (c) => applied(c, "paymentSessionRedirect").length === 1);
  const { redirectUrl } = calls.find((c) => c.mutation === "paymentSessionRedirect").variables;

  const page = await fetch(redirectUrl);
  expect(page.status === 200, `challenge page returned ${page.status}`);

  const res = await fetch(redirectUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent }),
  });
  const html = await res.text();
  expect(res.status === 200, `challenge submit returned ${res.status}`);
  return html;
}

async function approvedPayment(amount = "25.00") {
  const p = paymentBody({ amount });
  expect((await post("/payment_session", p)) === 201, "payment_session should return 201");
  await waitFor(p.gid, (c) => applied(c, "paymentSessionResolve").length === 1);
  return p;
}

const scenarios = {
  async approve() {
    const p = paymentBody({ number: "4242424242424242" });
    expect((await post("/payment_session", p)) === 201, "expected 201");
    const calls = await waitFor(p.gid, (c) => finalizations(c).length > 0);
    expect(applied(calls, "paymentSessionResolve").length === 1, "expected one paymentSessionResolve");
    expect(!calls[0].variables.authentication, "non-3DS resolve must not send authentication");
  },

  async decline() {
    const p = paymentBody({ number: "4000000000000002" });
    await post("/payment_session", p);
    const calls = await waitFor(p.gid, (c) => finalizations(c).length > 0);
    const reject = applied(calls, "paymentSessionReject")[0];
    expect(reject?.variables.reason.code === "CARD_DECLINED", "expected reject with CARD_DECLINED");
  },

  async "processing-error"() {
    const p = paymentBody({ number: "4000000000000119" });
    await post("/payment_session", p);
    const calls = await waitFor(p.gid, (c) => finalizations(c).length > 0);
    expect(applied(calls, "paymentSessionReject")[0]?.variables.reason.code === "PROCESSING_ERROR", "expected PROCESSING_ERROR");
  },

  async "3ds-pass"() {
    const p = paymentBody({ number: "4000000000003220" });
    await post("/payment_session", p);
    const html = await completeChallenge(p.gid, "pass");
    expect(html.includes("window.parent.location.href"), "challenge must return buyer via parent frame");

    const calls = await waitFor(p.gid, (c) => finalizations(c).length > 0);
    const order = calls.map((c) => c.mutation);
    expect(
      JSON.stringify(order) === JSON.stringify(["paymentSessionRedirect", "paymentSessionConfirm", "paymentSessionResolve"]),
      `unexpected mutation order: ${order.join(" -> ")}`,
    );
    const auth = calls.at(-1).variables.authentication?.authenticationData;
    expect(auth?.transStatus === "Y", "resolve must carry 3DS authentication data");
  },

  async "3ds-fail"() {
    const p = paymentBody({ number: "4000000000003220" });
    await post("/payment_session", p);
    await completeChallenge(p.gid, "fail");
    const calls = await waitFor(p.gid, (c) => finalizations(c).length > 0);
    expect(!calls.some((c) => c.mutation === "paymentSessionConfirm"), "failed 3DS must not call paymentSessionConfirm");
    const reject = applied(calls, "paymentSessionReject")[0];
    expect(reject?.variables.reason.code === "AUTHENTICATION_FAILED", "expected AUTHENTICATION_FAILED");
    expect(reject.variables.authentication?.authenticationData.transStatus === "N", "reject must carry failed 3DS data");
  },

  async "confirm-rejected"() {
    const p = paymentBody({ number: "4000000000003220" });
    await mock("/_config", { rejectConfirmFor: [p.id] });
    await post("/payment_session", p);
    await completeChallenge(p.gid, "pass");
    const calls = await waitFor(p.gid, (c) => finalizations(c).length > 0);
    expect(applied(calls, "paymentSessionReject")[0]?.variables.reason.code === "CONFIRMATION_REJECTED", "expected CONFIRMATION_REJECTED");
  },

  async "duplicate-payment-request"() {
    const p = paymentBody();
    const statuses = await Promise.all([post("/payment_session", p), post("/payment_session", p), post("/payment_session", p)]);
    expect(statuses.every((s) => s === 201), `all duplicates should get 201, got ${statuses}`);
    await waitFor(p.gid, (c) => finalizations(c).length > 0);
    expect((await post("/payment_session", p)) === 201, "late retry should still get 201");
    await sleep(300);
    expect(finalizations(await callsFor(p.gid)).length === 1, "payment must be finalized exactly once");
  },

  async "duplicate-confirm"() {
    const p = paymentBody({ number: "4000000000003220" });
    await post("/payment_session", p);
    await completeChallenge(p.gid, "pass");
    await waitFor(p.gid, (c) => finalizations(c).length > 0);
    const confirm = { id: p.id, gid: p.gid, confirmation_result: true };
    const statuses = await Promise.all([post("/confirm_session", confirm), post("/confirm_session", confirm)]);
    expect(statuses.every((s) => s === 200), `duplicate confirms should get 200, got ${statuses}`);
    await sleep(300);
    expect(finalizations(await callsFor(p.gid)).length === 1, "payment must be finalized exactly once");
  },

  async "double-submit-challenge"() {
    const p = paymentBody({ number: "4000000000003220" });
    await post("/payment_session", p);
    const calls = await waitFor(p.gid, (c) => applied(c, "paymentSessionRedirect").length === 1);
    const { redirectUrl } = calls[0].variables;
    const submit = (intent) =>
      fetch(redirectUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ intent }) });
    await Promise.all([submit("pass"), submit("fail")]);
    await waitFor(p.gid, (c) => finalizations(c).length > 0);
    await sleep(300);
    expect(finalizations(await callsFor(p.gid)).length === 1, "payment must be finalized exactly once");
    expect((await callsFor(p.gid)).filter((c) => c.mutation === "paymentSessionConfirm").length <= 1, "at most one confirm");
  },

  async "shopify-503-retry"() {
    const p = paymentBody();
    await mock("/_config", { failNext: { paymentSessionResolve: 2 } });
    await post("/payment_session", p);
    const calls = await waitFor(p.gid, (c) => applied(c, "paymentSessionResolve").length === 1, 8000);
    expect(calls.filter((c) => c.injectedFailure).length === 2, "expected two failed attempts before success");
  },

  async refund() {
    const p = await approvedPayment("25.00");
    const r = refundBody(p, "10.00");
    expect((await post("/refund_session", r)) === 201, "refund_session should return 201");
    expect((await post("/refund_session", r)) === 201, "duplicate refund should return 201");
    const calls = await waitFor(r.gid, (c) => finalizations(c).length > 0);
    await sleep(300);
    expect(applied(await callsFor(r.gid), "refundSessionResolve").length === 1 && calls.length === 1, "expected exactly one refundSessionResolve");
  },

  async "refund-over-balance"() {
    const p = await approvedPayment("25.00");
    const first = refundBody(p, "20.00");
    const second = refundBody(p, "10.00");
    await Promise.all([post("/refund_session", first), post("/refund_session", second)]);
    const [a, b] = await Promise.all([
      waitFor(first.gid, (c) => finalizations(c).length > 0),
      waitFor(second.gid, (c) => finalizations(c).length > 0),
    ]);
    const outcomes = [a[0].mutation, b[0].mutation].sort();
    expect(
      JSON.stringify(outcomes) === JSON.stringify(["refundSessionReject", "refundSessionResolve"]),
      `exactly one of two over-balance refunds should succeed, got ${outcomes}`,
    );
  },

  async "refund-processor-failure"() {
    const p = await approvedPayment("25.00");
    const r = refundBody(p, "5.99");
    await post("/refund_session", r);
    const calls = await waitFor(r.gid, (c) => finalizations(c).length > 0);
    expect(calls[0].mutation === "refundSessionReject", "a .99 refund should be rejected by the mock processor");

    const retry = refundBody(p, "25.00");
    await post("/refund_session", retry);
    const retryCalls = await waitFor(retry.gid, (c) => finalizations(c).length > 0);
    expect(retryCalls[0].mutation === "refundSessionResolve", "the failed refund must release its reserved balance");
  },

  async "capture-unsupported"() {
    const p = await approvedPayment();
    const id = `cap_${randomUUID().slice(0, 8)}`;
    const gid = `gid://shopify/CaptureSession/${id}`;
    expect((await post("/capture_session", { id, gid, payment_id: p.id, amount: p.amount, currency: p.currency, test: true })) === 201, "expected 201");
    const calls = await waitFor(gid, (c) => c.length > 0);
    expect(calls[0].mutation === "captureSessionReject", "capture sessions are rejected (refund is the implemented post-auth operation)");
  },

  async "unknown-shop"() {
    expect((await post("/payment_session", paymentBody(), { shop: "intruder.myshopify.com" })) === 401, "unknown shop must get 401");
  },
};

async function main() {
  const selected = process.argv.slice(2);
  const names = selected.length ? selected : Object.keys(scenarios);
  await mock("/_reset", {});

  let failed = 0;
  for (const name of names) {
    const started = Date.now();
    try {
      await scenarios[name]();
      console.log(`PASS  ${name.padEnd(28)} ${Date.now() - started}ms`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name.padEnd(28)} ${err.message}`);
    }
  }

  console.log(`\n${names.length - failed}/${names.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
