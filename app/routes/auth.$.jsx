import { getShopify } from "~/shopify.server";

export const loader = async ({ request }) => {
  await getShopify().authenticate.admin(request);
  return null;
};
