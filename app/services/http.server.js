import { requestLogger } from "./logger.server";
import { isKnownShop } from "./shopAuth.server";
import { InvalidRequestError, NotFoundError } from "./payments.server";

/**
 * Shared wrapper for the endpoints Shopify calls. Verifies the shop, parses
 * JSON and maps errors to status codes. Non-2xx responses make Shopify retry,
 * so only genuine failures return 5xx.
 */
export function shopifySessionEndpoint(name, handler) {
  return async ({ request }) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const shop = request.headers.get("shopify-shop-domain");
    const requestId = request.headers.get("shopify-request-id");
    const log = requestLogger(request, { endpoint: name });

    if (!(await isKnownShop(shop))) {
      log.warn({ event: "request.unknown_shop" }, "rejected request from unknown shop");
      return new Response(null, { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    try {
      return await handler(body, { shop, requestId, log });
    } catch (err) {
      if (err instanceof InvalidRequestError) {
        log.warn({ event: "request.invalid", err: err.message }, "invalid request");
        return new Response(null, { status: 422 });
      }
      if (err instanceof NotFoundError) {
        log.warn({ event: "request.not_found", err: err.message }, "unknown session");
        return new Response(null, { status: 404 });
      }
      log.error({ event: "request.failed", err }, "request failed");
      return new Response(null, { status: 500 });
    }
  };
}

export const created = () => new Response(null, { status: 201 });
export const ok = () => new Response(null, { status: 200 });
