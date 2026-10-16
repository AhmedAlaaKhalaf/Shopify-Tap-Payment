#!/usr/bin/env node
/**
 * Minimal stand-in for Shopify's Payments Apps GraphQL API, for local runs
 * without Payments Partner approval. It enforces the documented rules the app
 * relies on:
 *   - each mutation is idempotent per session id;
 *   - resolve and reject are mutually exclusive;
 *   - after paymentSessionConfirm, resolve/reject fail until the confirm
 *     callback has been sent to the app;
 *   - `authentication` is required if and only if a redirect succeeded.
 * After paymentSessionConfirm it POSTs the confirmation result to the app.
 *
 * Control endpoints: GET /_calls[?gid=], POST /_reset, POST /_config
 *   { "rejectConfirmFor": ["<payment id>"], "failNext": { "<mutation>": 2 } }
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_SHOPIFY_PORT || 4000);
const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const SELF_URL = `http://localhost:${PORT}`;
const CONFIRM_DELAY_MS = Number(process.env.MOCK_CONFIRM_DELAY_MS || 100);

let calls = [];
let sessions = new Map();
let config = { rejectConfirmFor: new Set(), failNext: {} };

const idFromGid = (gid) => String(gid).split("/").pop();

function sessionFor(gid) {
  if (!sessions.has(gid)) sessions.set(gid, { finalized: null, response: null, redirected: false, confirm: null });
  return sessions.get(gid);
}

const userError = (message, field = ["id"]) => ({ userErrors: [{ field, message }] });

function paymentPayload(gid, code, redirectUrl) {
  return {
    paymentSession: {
      id: gid,
      state: { code },
      nextAction: redirectUrl ? { action: "REDIRECT", context: { redirectUrl } } : null,
    },
    userErrors: [],
  };
}

function finalizeOnce(gid, mutation, build) {
  const s = sessionFor(gid);
  if (s.finalized === mutation) return s.response;
  if (s.finalized) return userError(`Session already finalized with ${s.finalized}`);
  s.finalized = mutation;
  s.response = build();
  return s.response;
}

async function sendConfirmCallback(gid, shop) {
  const id = idFromGid(gid);
  const s = sessionFor(gid);
  const body = { id, gid, confirmation_result: !config.rejectConfirmFor.has(id) };
  s.confirm.sent = true;
  try {
    const res = await fetch(`${APP_URL}/confirm_session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Shopify-Shop-Domain": shop,
        "Shopify-Request-Id": `mock-${Date.now()}`,
        "Shopify-Api-Version": "2026-07",
      },
      body: JSON.stringify(body),
    });
    log("confirm_callback", { gid, confirmation_result: body.confirmation_result, status: res.status });
  } catch (err) {
    log("confirm_callback_failed", { gid, err: err.message });
  }
}

const resolvers = {
  paymentSessionRedirect({ id: gid, redirectUrl }) {
    const s = sessionFor(gid);
    if (s.finalized) return userError("Session already finalized");
    s.redirected = true;
    return paymentPayload(gid, "REDIRECTING", redirectUrl);
  },

  paymentSessionConfirm({ id: gid }, shop) {
    const s = sessionFor(gid);
    if (s.finalized) return userError("Session already finalized");
    if (!s.confirm) {
      s.confirm = { sent: false };
      setTimeout(() => sendConfirmCallback(gid, shop), CONFIRM_DELAY_MS);
    }
    return paymentPayload(gid, "CONFIRMING", `${SELF_URL}/checkout/${idFromGid(gid)}/processing`);
  },

  paymentSessionResolve(vars) {
    return finalizePayment(vars, "paymentSessionResolve", "RESOLVED", "thank_you");
  },

  paymentSessionReject(vars) {
    return finalizePayment(vars, "paymentSessionReject", "REJECTED", "payment_failed");
  },

  refundSessionResolve: ({ id }) => finalizeOnce(id, "refundSessionResolve", () => ({ refundSession: { id, state: { code: "RESOLVED" } }, userErrors: [] })),
  refundSessionReject: ({ id }) => finalizeOnce(id, "refundSessionReject", () => ({ refundSession: { id, state: { code: "REJECTED" } }, userErrors: [] })),
  captureSessionReject: ({ id }) => finalizeOnce(id, "captureSessionReject", () => ({ captureSession: { id, state: { code: "REJECTED" } }, userErrors: [] })),
  voidSessionReject: ({ id }) => finalizeOnce(id, "voidSessionReject", () => ({ voidSession: { id, state: { code: "REJECTED" } }, userErrors: [] })),
  paymentsAppConfigure: ({ externalHandle, ready }) => ({ paymentsAppConfiguration: { externalHandle, ready }, userErrors: [] }),
};

function finalizePayment(vars, mutation, code, page) {
  const gid = vars.id;
  const s = sessionFor(gid);
  if (s.confirm && !s.confirm.sent) return userError("Confirmation result has not been sent yet");
  if (s.redirected && !vars.authentication) return userError("authentication is required after a 3DS redirect", ["authentication"]);
  if (!s.redirected && vars.authentication) return userError("authentication is only allowed after a 3DS redirect", ["authentication"]);
  return finalizeOnce(gid, mutation, () => paymentPayload(gid, code, `${SELF_URL}/checkout/${idFromGid(gid)}/${page}`));
}

function mutationName(query) {
  return /mutation\s+\w+\s*(?:\([^)]*\))?\s*\{\s*(\w+)/s.exec(query ?? "")?.[1];
}

function log(event, data) {
  if (process.env.MOCK_SHOPIFY_QUIET) return;
  console.log(JSON.stringify({ service: "mock-shopify", event, ...data }));
}

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
  });

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF_URL);

  try {
    const gql = /^\/([^/]+)\/payments_apps\/api\/([^/]+)\/graphql\.json$/.exec(url.pathname);
    if (req.method === "POST" && gql) {
      const [, shop, version] = gql;
      if (!req.headers["x-shopify-access-token"]) return send(res, 401, { errors: "Missing access token" });

      const { query, variables = {} } = await readJson(req);
      const mutation = mutationName(query);
      const resolver = resolvers[mutation];
      if (!resolver) return send(res, 200, { errors: [{ message: `Unknown operation ${mutation}` }] });

      if (config.failNext[mutation] > 0) {
        config.failNext[mutation] -= 1;
        calls.push({ mutation, gid: variables.id, shop, version, injectedFailure: true, at: new Date().toISOString() });
        log("injected_failure", { mutation, gid: variables.id });
        return send(res, 503, { errors: "Service unavailable (injected)" });
      }

      const payload = resolver(variables, shop);
      calls.push({ mutation, gid: variables.id, shop, version, variables, userErrors: payload.userErrors, at: new Date().toISOString() });
      log("mutation", { mutation, gid: variables.id, userErrors: payload.userErrors });
      return send(res, 200, { data: { [mutation]: payload } });
    }

    if (req.method === "GET" && url.pathname === "/_calls") {
      const gid = url.searchParams.get("gid");
      return send(res, 200, gid ? calls.filter((c) => c.gid === gid) : calls);
    }

    if (req.method === "POST" && url.pathname === "/_reset") {
      calls = [];
      sessions = new Map();
      config = { rejectConfirmFor: new Set(), failNext: {} };
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/_config") {
      const body = await readJson(req);
      body.rejectConfirmFor?.forEach((id) => config.rejectConfirmFor.add(id));
      Object.assign(config.failNext, body.failNext ?? {});
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname.startsWith("/checkout/")) {
      return send(res, 200, `<!doctype html><p>Mock Shopify checkout: ${url.pathname}</p>`, "text/html");
    }

    send(res, 404, { errors: "Not found" });
  } catch (err) {
    send(res, 500, { errors: err.message });
  }
});

server.listen(PORT, () => log("listening", { url: SELF_URL, appUrl: APP_URL }));
