import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaymentsAppsClient, paymentsEndpoint } from "~/services/paymentsAppsClient.server";
import { toMinor } from "~/services/money";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const resolved = { data: { paymentSessionResolve: { paymentSession: { id: "gid" }, userErrors: [] } } };

function clientWith(fetchImpl) {
  return createPaymentsAppsClient({ shop: "s.myshopify.com", accessToken: "t", fetchImpl, baseDelayMs: 1 });
}

describe("PaymentsAppsClient", () => {
  afterEach(() => {
    delete process.env.SHOPIFY_PAYMENTS_GQL_URL;
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, resolved));

    const { userErrors } = await clientWith(fetchImpl).resolvePayment("gid");
    expect(userErrors).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry userErrors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(200, { data: { paymentSessionResolve: { userErrors: [{ field: ["id"], message: "already finalized" }] } } }),
    );
    const { userErrors } = await clientWith(fetchImpl).resolvePayment("gid");
    expect(userErrors).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry 4xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(401, {}));
    await expect(clientWith(fetchImpl).resolvePayment("gid")).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(500, {}));
    await expect(clientWith(fetchImpl).resolvePayment("gid")).rejects.toThrow("HTTP 500");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("sends the access token and the right operation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, resolved));
    await clientWith(fetchImpl).resolvePayment("gid://shopify/PaymentSession/1", { networkTransactionId: "n1" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://s.myshopify.com/payments_apps/api/2026-07/graphql.json");
    expect(init.headers["X-Shopify-Access-Token"]).toBe("t");
    const body = JSON.parse(init.body);
    expect(body.query).toMatch(/paymentSessionResolve\(/);
    expect(body.variables).toMatchObject({ id: "gid://shopify/PaymentSession/1", networkTransactionId: "n1" });
  });

  it("supports an endpoint override for the mock server", () => {
    process.env.SHOPIFY_PAYMENTS_GQL_URL = "http://localhost:4000/{shop}/payments_apps/api/{version}/graphql.json";
    expect(paymentsEndpoint("a.myshopify.com", "2026-07")).toBe("http://localhost:4000/a.myshopify.com/payments_apps/api/2026-07/graphql.json");
  });
});

describe("toMinor", () => {
  it("converts decimal strings without float errors", () => {
    expect(toMinor("123.45", "SAR")).toBe(12345);
    expect(toMinor("0.1", "USD")).toBe(10);
    expect(toMinor("10", "USD")).toBe(1000);
    expect(toMinor("1.234", "KWD")).toBe(1234);
    expect(toMinor("500", "JPY")).toBe(500);
  });

  it("rejects malformed or over-precise amounts", () => {
    expect(() => toMinor("1,00", "USD")).toThrow();
    expect(() => toMinor("1.001", "USD")).toThrow();
    expect(() => toMinor("-1", "USD")).toThrow();
  });
});
