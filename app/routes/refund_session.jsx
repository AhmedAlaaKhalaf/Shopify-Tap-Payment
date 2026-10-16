import { created, shopifySessionEndpoint } from "~/services/http.server";
import { receiveRefundSession, scheduleRefundWork } from "~/services/refunds.server";

// Shopify -> refund_session_url. Shopify requires 201 Created.
export const action = shopifySessionEndpoint("refund_session", async (body, ctx) => {
  const { refund } = await receiveRefundSession(body, ctx);
  scheduleRefundWork(refund);
  return created();
});
