import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {usesDuckDB} from "../src/commands.js";

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
