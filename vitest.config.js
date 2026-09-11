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
          TEST_PAGES: JSON.stringify([{match: "about", access: "public"}, {match: "ntd", access: "disabled"}])
        }
      }
    })],
    test: {setupFiles: ["./test/apply-migrations.js"]}
  };
});
