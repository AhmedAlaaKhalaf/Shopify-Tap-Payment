import { logger } from "./logger.server";

const NEXT_ACTION = `nextAction { action context { ... on PaymentSessionActionsRedirect { redirectUrl } } }`;
const PAYMENT_SESSION = `paymentSession { id state { ... on PaymentSessionState { code } } ${NEXT_ACTION} }`;

export const OPERATIONS = {
  paymentSessionResolve: `mutation PaymentSessionResolve($id: ID!, $authorizationExpiresAt: DateTime, $networkTransactionId: String, $authentication: PaymentSessionThreeDSecureAuthentication) {
  paymentSessionResolve(id: $id, authorizationExpiresAt: $authorizationExpiresAt, networkTransactionId: $networkTransactionId, authentication: $authentication) {
    ${PAYMENT_SESSION}
    userErrors { field message }
  }
}`,
  paymentSessionReject: `mutation PaymentSessionReject($id: ID!, $reason: PaymentSessionRejectionReasonInput!, $authentication: PaymentSessionThreeDSecureAuthentication) {
  paymentSessionReject(id: $id, reason: $reason, authentication: $authentication) {
    ${PAYMENT_SESSION}
    userErrors { field message }
  }
}`,
  paymentSessionRedirect: `mutation PaymentSessionRedirect($id: ID!, $redirectUrl: URL!) {
  paymentSessionRedirect(id: $id, redirectUrl: $redirectUrl) {
    ${PAYMENT_SESSION}
    userErrors { field message }
  }
}`,
  paymentSessionConfirm: `mutation PaymentSessionConfirm($id: ID!) {
  paymentSessionConfirm(id: $id) {
    ${PAYMENT_SESSION}
    userErrors { field message }
  }
}`,
  refundSessionResolve: `mutation RefundSessionResolve($id: ID!) {
  refundSessionResolve(id: $id) {
    refundSession { id state { ... on RefundSessionState { code } } }
    userErrors { field message }
  }
}`,
  refundSessionReject: `mutation RefundSessionReject($id: ID!, $reason: RefundSessionRejectionReasonInput!) {
  refundSessionReject(id: $id, reason: $reason) {
    refundSession { id state { ... on RefundSessionState { code } } }
    userErrors { field message }
  }
}`,
  captureSessionReject: `mutation CaptureSessionReject($id: ID!, $reason: CaptureSessionRejectionReasonInput!) {
  captureSessionReject(id: $id, reason: $reason) {
    captureSession { id state { ... on CaptureSessionState { code } } }
    userErrors { field message }
  }
}`,
  voidSessionReject: `mutation VoidSessionReject($id: ID!, $reason: VoidSessionRejectionReasonInput!) {
  voidSessionReject(id: $id, reason: $reason) {
    voidSession { id state { ... on VoidSessionState { code } } }
    userErrors { field message }
  }
}`,
  paymentsAppConfigure: `mutation PaymentsAppConfigure($externalHandle: String, $ready: Boolean!) {
  paymentsAppConfigure(externalHandle: $externalHandle, ready: $ready) {
    paymentsAppConfiguration { externalHandle ready }
    userErrors { field message }
  }
}`,
};

export class PaymentsAppsError extends Error {
  constructor(message, { retryable = false, status, cause } = {}) {
    super(message, { cause });
    this.retryable = retryable;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function paymentsEndpoint(shop, apiVersion) {
  const override = process.env.SHOPIFY_PAYMENTS_GQL_URL;
  if (override) return override.replace("{shop}", shop).replace("{version}", apiVersion);
  return `https://${shop}/payments_apps/api/${apiVersion}/graphql.json`;
}

/**
 * Payments Apps GraphQL client.
 *
 * Retries network failures, 429 and 5xx with exponential backoff and jitter.
 * Shopify deduplicates each mutation per session id, so a retried mutation
 * is never applied twice. `userErrors` are business errors: they are returned
 * to the caller and never retried.
 */
export function createPaymentsAppsClient({
  shop,
  accessToken,
  apiVersion = process.env.PAYMENTS_API_VERSION || "2026-07",
  fetchImpl = globalThis.fetch,
  maxAttempts = 5,
  baseDelayMs = 200,
}) {
  const endpoint = paymentsEndpoint(shop, apiVersion);
  const log = logger.child({ shop, apiVersion });

  async function perform(mutation, variables) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ query: OPERATIONS[mutation], variables }),
        });

        if (response.status === 429 || response.status >= 500) {
          throw new PaymentsAppsError(`HTTP ${response.status}`, { retryable: true, status: response.status });
        }
        if (!response.ok) {
          throw new PaymentsAppsError(`HTTP ${response.status}`, { status: response.status });
        }

        const body = await response.json();
        if (body.errors?.length) {
          const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
          throw new PaymentsAppsError(body.errors.map((e) => e.message).join("; "), { retryable: throttled });
        }

        const payload = body.data?.[mutation] ?? {};
        const userErrors = payload.userErrors ?? [];
        log[userErrors.length ? "warn" : "info"](
          { event: "graphql.mutation", mutation, gid: variables.id, attempt, durationMs: Date.now() - startedAt, userErrors },
          `${mutation} ${userErrors.length ? "returned userErrors" : "ok"}`,
        );
        return { payload, userErrors };
      } catch (err) {
        const error =
          err instanceof PaymentsAppsError ? err : new PaymentsAppsError(err.message, { retryable: true, cause: err });
        lastError = error;

        log.warn(
          { event: "graphql.mutation_failed", mutation, gid: variables.id, attempt, retryable: error.retryable, err: error.message },
          `${mutation} failed`,
        );
        if (!error.retryable || attempt === maxAttempts) break;

        const backoff = baseDelayMs * 2 ** (attempt - 1);
        await sleep(backoff + Math.random() * backoff * 0.2);
      }
    }

    throw lastError;
  }

  return {
    resolvePayment: (gid, { authorizationExpiresAt, networkTransactionId, authentication } = {}) =>
      perform("paymentSessionResolve", { id: gid, authorizationExpiresAt, networkTransactionId, authentication }),
    rejectPayment: (gid, reason, { authentication } = {}) =>
      perform("paymentSessionReject", { id: gid, reason, authentication }),
    redirectPayment: (gid, redirectUrl) => perform("paymentSessionRedirect", { id: gid, redirectUrl }),
    confirmPayment: (gid) => perform("paymentSessionConfirm", { id: gid }),
    resolveRefund: (gid) => perform("refundSessionResolve", { id: gid }),
    rejectRefund: (gid, reason) => perform("refundSessionReject", { id: gid, reason }),
    rejectCapture: (gid, reason) => perform("captureSessionReject", { id: gid, reason }),
    rejectVoid: (gid, reason) => perform("voidSessionReject", { id: gid, reason }),
    configure: ({ externalHandle, ready }) => perform("paymentsAppConfigure", { externalHandle, ready }),
  };
}

export function nextActionRedirectUrl(payload) {
  return payload?.paymentSession?.nextAction?.context?.redirectUrl ?? null;
}
