import { getShopify } from "~/shopify.server";
import prisma from "~/db.server";
import { logger } from "~/services/logger.server";

export const action = async ({ request }) => {
  const { topic, shop } = await getShopify().authenticate.webhook(request);
  logger.info({ event: "webhook.received", topic, shop }, "webhook");

  switch (topic) {
    case "APP_UNINSTALLED":
      await prisma.session.deleteMany({ where: { shop } });
      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
      // No customer PII is stored beyond what is needed to reconcile payments.
      break;
    default:
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response(null, { status: 200 });
};
