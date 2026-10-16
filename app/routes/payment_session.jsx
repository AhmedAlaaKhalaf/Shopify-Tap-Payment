import { created, shopifySessionEndpoint } from "~/services/http.server";
import { receivePaymentSession, schedulePaymentWork } from "~/services/payments.server";

// Shopify -> payment_session_url. Persist, acknowledge, process asynchronously.
export const action = shopifySessionEndpoint("payment_session", async (body, ctx) => {
  const { session } = await receivePaymentSession(body, ctx);
  schedulePaymentWork(session);
  return created();
});
