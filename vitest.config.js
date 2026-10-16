import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.js"],
    env: {
      DATABASE_URL: "file:./test.sqlite",
      MOCK_PROCESSOR_LATENCY_MS: "0",
      SHOPIFY_APP_URL: "https://app.test",
      LOG_LEVEL: "silent",
    },
    // One SQLite file is shared by all suites.
    fileParallelism: false,
  },
});
