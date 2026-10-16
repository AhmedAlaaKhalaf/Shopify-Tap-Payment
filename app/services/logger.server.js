import pino from "pino";

/**
 * Lifecycle log fields used across the app:
 *   event, shop, requestId, paymentId, refundId, gid,
 *   fromState, toState, outcome, mutation, attempt, userErrors
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  base: { service: "tap-shopify-payments" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["paymentMethod", "payment_method", "*.payment_method", "card.pan", "*.card.pan", "accessToken"],
    censor: "[redacted]",
  },
  transport: process.env.LOG_PRETTY ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});

export function requestLogger(request, extra = {}) {
  return logger.child({
    shop: request.headers.get("shopify-shop-domain") ?? undefined,
    requestId: request.headers.get("shopify-request-id") ?? undefined,
    apiVersion: request.headers.get("shopify-api-version") ?? undefined,
    ...extra,
  });
}
