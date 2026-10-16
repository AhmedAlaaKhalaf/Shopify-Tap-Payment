import "@shopify/shopify-app-remix/adapters/node";
import { AppDistribution, LATEST_API_VERSION, shopifyApp } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

let shopify;

/**
 * Built lazily so the payment session endpoints can run in simulator /
 * hard-coded token mode without Shopify OAuth credentials configured.
 */
export function getShopify() {
  if (!shopify) {
    shopify = shopifyApp({
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      // Admin API version for OAuth/webhooks. The Payments Apps API version is
      // configured separately (PAYMENTS_API_VERSION).
      apiVersion: LATEST_API_VERSION,
      scopes: process.env.SCOPES?.split(","),
      appUrl: process.env.SHOPIFY_APP_URL || "",
      authPathPrefix: "/auth",
      isEmbeddedApp: false,
      sessionStorage: new PrismaSessionStorage(prisma),
      distribution: AppDistribution.AppStore,
      useOnlineTokens: false,
    });
  }
  return shopify;
}
