import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {clearLoaderCache, usesDuckDB} from "../src/commands.js";

test("clearLoaderCache drops every loader output and keeps Framework's own caches", () => {
  const root = mkdtempSync(join(tmpdir(), "obs-src-"));
  const cache = join(root, ".observablehq", "cache");
  try {
    for (const p of ["_npm/htl@1.0.0/_esm.js", "_node/x.js", "_build.json", "data/a.parquet", "metrics.parquet", "pages/b.csv", "_data/c.parquet"]) {
      mkdirSync(join(cache, p, ".."), {recursive: true});
      writeFileSync(join(cache, p), "x");
    }
    clearLoaderCache(root);
    assert.deepEqual(readdirSync(cache).sort(), ["_build.json", "_node", "_npm"]);
    clearLoaderCache(join(root, "missing"));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("usesDuckDB finds sql front matter, sql blocks and DuckDBClient, and skips the cache", () => {
  const root = mkdtempSync(join(tmpdir(), "obs-src-"));
  try {
    writeFileSync(join(root, "index.md"), "# Plain\n\n```js\nPlot.plot()\n```\n");
    mkdirSync(join(root, ".observablehq", "cache"), {recursive: true});
    writeFileSync(join(root, ".observablehq", "cache", "x.js"), "DuckDBClient.of()");
    assert.equal(usesDuckDB(root), false);
    for (const text of ["---\nsql:\n  t: data/t.parquet\n---\n", "```sql\nSELECT 1\n```\n", "const db = DuckDBClient.of({});", "await sql`SELECT 1`"]) {
      mkdirSync(join(root, "pages"), {recursive: true});
      writeFileSync(join(root, "pages", "p.md"), text);
      assert.equal(usesDuckDB(root), true, text);
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("pendingMigrations compares the gate's files with what the database recorded", async () => {
  const {pendingMigrations} = await import("../src/commands.js");
  const root = mkdtempSync(join(tmpdir(), "obs-gate-"));
  try {
    const dir = join(root, "node_modules", "@recodelabs", "observatory-gate", "migrations");
    mkdirSync(dir, {recursive: true});
    for (const f of ["0001_auth.sql", "0002_oidc.sql"]) writeFileSync(join(dir, f), "--");
    mkdirSync(join(root, "gate"));
    assert.deepEqual(pendingMigrations(join(root, "gate"), "db", {query: () => ["0001_auth.sql"]}), ["0002_oidc.sql"]);
    assert.deepEqual(pendingMigrations(join(root, "gate"), "db", {query: () => []}), ["0001_auth.sql", "0002_oidc.sql"]);
    assert.deepEqual(pendingMigrations(join(root, "gate"), "db", {query: () => ["0001_auth.sql", "0002_oidc.sql"]}), []);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
