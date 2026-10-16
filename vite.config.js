import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Shopify CLI passes HOST; the app reads SHOPIFY_APP_URL.
if (process.env.HOST && (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const port = Number(process.env.PORT || 3000);

export default defineConfig({
  server: {
    port,
    allowedHosts: true,
    hmr: { port: Number(process.env.HMR_SERVER_PORT || 8002) },
  },
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: false,
      },
    }),
  ],
});
