#!/usr/bin/env node
/**
 * Presentation helper. Sends one scenario to the running app and prints a
 * timeline of Shopify mutations and state transitions.
 *
 *   npm run demo -- approve | decline | error | 3ds | duplicate
 *   npm run demo -- refund <paymentId> [amount]
 *   npm run demo -- show <paymentId>
 */
import { execFile } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const APP_URL = "http://localhost:3000";
const MOCK_URL = "http://localhost:4000";
const SHOP = process.env.SIM_SHOP || "tap-case-study.myshopify.com";
const CARDS = { approve: "4242424242424242", decline: "4000000000000002", error: "4000000000000119", "3ds": "4000000000003220" };

const prisma = new PrismaClient();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const newId = (prefix) => `${prefix}${Date.now().toString(36)}`;

async function post(path, body) {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Shopify-Shop-Domain": SHOP, "Shopify-Request-Id": newId("req-") },
    body: JSON.stringify(body),
  });
  console.log(`  Shopify -> POST ${path}  =>  HTTP ${res.status}`);
  return res.status;
}

function paymentBody(id, number, amount = "49.00") {
  return {
    id,
    gid: `gid://shopify/PaymentSession/${id}`,
    group: `g-${id}`,
    amount,
    currency: "SAR",
    test: true,
    kind: "sale",
    proposed_at: new Date().toISOString(),
    payment_method: {
      type: "credit_card",
      data: {
        fingerprint: "stub-local-dev",
        encrypted_message: Buffer.from(JSON.stringify({ number })).toString("base64"),
        ephemeral_public_key: "stub",
        tag: "stub",
      },
    },
    customer: { email: "buyer@example.com", billing_address: { family_name: "Smith" } },
  };
}

const callsFor = async (gid) => (await fetch(`${MOCK_URL}/_calls?gid=${encodeURIComponent(gid)}`)).json();
const isFinal = (calls) => calls.some((c) => /Session(Resolve|Reject)$/.test(c.mutation) && !c.userErrors?.length);

async function waitForFinal(gid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isFinal(await callsFor(gid))) return;
    await sleep(100);
  }
}

async function show(entity, id) {
  const gid = `gid://shopify/${entity === "refund" ? "RefundSession" : "PaymentSession"}/${id}`;
  const calls = await callsFor(gid);
  const audit = await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { id: "asc" } });
  const session =
    entity === "refund" ? await prisma.refundSession.findUnique({ where: { id } }) : await prisma.paymentSession.findUnique({ where: { id } });

  const events = [
    ...audit.map((a) => ({
      at: a.createdAt,
      text:
        a.event === "transition"
          ? `state      ${a.fromState} -> ${a.toState}`
          : `${a.event.padEnd(10)} ${a.data ?? ""}`,
    })),
    ...calls.map((c) => {
      const extra = c.variables?.reason ? ` reason=${c.variables.reason.code}` : "";
      const auth = c.variables?.authentication ? ` 3DS transStatus=${c.variables.authentication.authenticationData.transStatus}` : "";
      return { at: new Date(c.at), text: `mutation   ${c.mutation}${extra}${auth}${c.injectedFailure ? " (503, retried)" : ""}` };
    }),
  ].sort((a, b) => a.at - b.at);

  console.log(`\n  Timeline for ${entity} ${id}`);
  for (const e of events) console.log(`  ${e.at.toISOString().slice(11, 23)}  ${e.text}`);
  if (session) {
    console.log(`\n  Final: state=${session.state} outcome=${session.outcome ?? "-"}${session.rejectCode ? ` reason=${session.rejectCode}` : ""}`);
    if (session.rejectMessage) console.log(`  Message: ${session.rejectMessage}`);
    if (session.refundedMinor !== undefined) console.log(`  Refunded so far: ${(session.refundedMinor / 100).toFixed(2)} of ${session.amount} ${session.currency}`);
  }
  const finals = calls.filter((c) => /Session(Resolve|Reject)$/.test(c.mutation) && !c.injectedFailure);
  console.log(`  Finalization mutations sent: ${finals.length}\n`);
}

const commands = {
  async approve() {
    return simplePayment("approve");
  },
  async decline() {
    return simplePayment("decline");
  },
  async error() {
    return simplePayment("error");
  },

  async "3ds"() {
    const id = newId("demo");
    const gid = `gid://shopify/PaymentSession/${id}`;
    console.log(`\n  3DS payment ${id} (card ending 3220)`);
    await post("/payment_session", paymentBody(id, CARDS["3ds"]));

    let redirect;
    for (let i = 0; i < 50 && !redirect; i++) {
      redirect = (await callsFor(gid)).find((c) => c.mutation === "paymentSessionRedirect");
      if (!redirect) await sleep(100);
    }
    const url = redirect.variables.redirectUrl;
    console.log(`  App -> paymentSessionRedirect: ${url}`);
    console.log("\n  Opening the challenge page. Click Authenticate or Fail authentication...");
    execFile("open", [url]);

    await waitForFinal(gid, 120_000);
    await show("payment", id);
    console.log(`  Refund it with: npm run demo -- refund ${id} 20.00\n`);
  },

  async duplicate() {
    const id = newId("dup");
    console.log(`\n  Shopify retries the same payment ${id} three times at once`);
    const body = paymentBody(id, CARDS.approve);
    await Promise.all([post("/payment_session", body), post("/payment_session", body), post("/payment_session", body)]);
    await waitForFinal(body.gid);
    await sleep(300);
    await show("payment", id);
  },

  async refund(paymentId, amount = "20.00") {
    if (!paymentId) throw new Error("usage: npm run demo -- refund <paymentId> [amount]");
    const payment = await prisma.paymentSession.findUnique({ where: { id: paymentId } });
    if (!payment) throw new Error(`unknown payment ${paymentId}`);

    const id = newId("ref");
    const gid = `gid://shopify/RefundSession/${id}`;
    console.log(`\n  Refund ${amount} ${payment.currency} of payment ${paymentId}`);
    await post("/refund_session", {
      id,
      gid,
      payment_id: paymentId,
      amount,
      currency: payment.currency,
      test: true,
      proposed_at: new Date().toISOString(),
    });
    await waitForFinal(gid);
    await show("refund", id);
    await show("payment", paymentId);
  },

  async show(id) {
    if (!id) throw new Error("usage: npm run demo -- show <paymentId>");
    await show("payment", id);
  },
};

async function simplePayment(kind) {
  const id = newId("demo");
  console.log(`\n  ${kind} payment ${id} (card ending ${CARDS[kind].slice(-4)})`);
  await post("/payment_session", paymentBody(id, CARDS[kind]));
  await waitForFinal(`gid://shopify/PaymentSession/${id}`);
  await show("payment", id);
  if (kind === "approve") console.log(`  Refund it with: npm run demo -- refund ${id} 20.00\n`);
}

const [name, ...args] = process.argv.slice(2);
if (!commands[name]) {
  console.log("usage: npm run demo -- approve | decline | error | 3ds | duplicate | refund <paymentId> [amount] | show <paymentId>");
  process.exit(1);
}
commands[name](...args)
  .catch((err) => {
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
