import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEST_DB = fileURLToPath(new URL("../prisma/test.sqlite", import.meta.url));

/** Builds a throwaway SQLite database from the committed migrations. */
export default function setup() {
  rmSync(TEST_DB, { force: true });
  rmSync(`${TEST_DB}-journal`, { force: true });
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: "file:./test.sqlite" },
    stdio: "ignore",
  });
}
