import path from "node:path";
import {cloudflareTest, readD1Migrations} from "@cloudflare/vitest-plugin";
import {defineConfig} from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      wrangler: {configPath: "./wrangler.jsonc"},
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
          BASE_URL: "http://example.com",
          // Pinned empty so a developer's real key in .dev.vars can never make the suite
          // send mail: src/mail.js logs to the console when this is unset.
          RESEND_API_KEY: ""
        }
      }
    })],
    test: {setupFiles: ["./test/apply-migrations.js"]}
  };
});
