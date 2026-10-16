import { ok, shopifySessionEndpoint } from "~/services/http.server";
import { receiveConfirmation } from "~/services/payments.server";

// Shopify -> confirmation_callback_url, after paymentSessionConfirm. Shopify
// ignores the body; the outcome is reported with resolve/reject instead.
export const action = shopifySessionEndpoint("confirm_session", async (body, ctx) => {
  await receiveConfirmation(body, ctx);
  return ok();
});
