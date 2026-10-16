import prisma from "~/db.server";
import { createPaymentsAppsClient } from "./paymentsAppsClient.server";

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function staticShops() {
  return (process.env.STATIC_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function offlineSession(shop) {
  return prisma.session.findFirst({ where: { shop, isOnline: false } });
}

/**
 * A shop may call the session endpoints if it installed the app (OAuth) or is
 * listed in STATIC_SHOPS (hard-coded token / simulator mode).
 */
export async function isKnownShop(shop) {
  if (!shop || !SHOP_DOMAIN.test(shop)) return false;
  if (staticShops().includes(shop)) return true;
  return Boolean(await offlineSession(shop));
}

/** Offline OAuth token first, then the hard-coded SHOPIFY_ACCESS_TOKEN fallback. */
export async function getAccessToken(shop) {
  const session = await offlineSession(shop);
  if (session?.accessToken) return session.accessToken;
  if (process.env.SHOPIFY_ACCESS_TOKEN && staticShops().includes(shop)) return process.env.SHOPIFY_ACCESS_TOKEN;
  throw new Error(`No Payments Apps access token for ${shop}`);
}

export async function clientForShop(shop) {
  return createPaymentsAppsClient({ shop, accessToken: await getAccessToken(shop) });
}
