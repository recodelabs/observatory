import assert from "node:assert/strict";
import {test} from "node:test";
import {ENGINE, patchClient, patchLibraries} from "../src/duckdb2.js";

const client = `import * as duckdb from "npm:@duckdb/duckdb-wasm";
const bundles = {
  mvp: {
    mainModule: import.meta.resolve("npm:@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"),
    mainWorker: import.meta.resolve("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js")
  },
  eh: {
    mainModule: import.meta.resolve("npm:@duckdb/duckdb-wasm/dist/duckdb-eh.wasm"),
    mainWorker: import.meta.resolve("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js")
  }
};
const bundle = duckdb.selectBundle(bundles);
`;

const libraries = `  if (hasDuckDB) {
    implicits.add("npm:@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm");
    implicits.add("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js");
    implicits.add("npm:@duckdb/duckdb-wasm/dist/duckdb-eh.wasm");
    implicits.add("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js");
  }
`;

test("the client asks for the base build only, and patching twice changes nothing", () => {
  const once = patchClient(client);
  assert.match(once, new RegExp(`dist/${ENGINE.replaceAll(".", "\\.")}"`));
  assert.doesNotMatch(once, /mvp|eh\.wasm/);
  assert.ok(once.includes("const bundle = duckdb.selectBundle(bundles);"));
  assert.equal(patchClient(once), once);
});

test("the build copies the base engine and worker", () => {
  const once = patchLibraries(libraries);
  assert.equal(once, `  if (hasDuckDB) {
    implicits.add("npm:@duckdb/duckdb-wasm/dist/${ENGINE}");
    implicits.add("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js");
  }
`);
  assert.equal(patchLibraries(once), once);
  // An older engine name is replaced.
  assert.equal(patchLibraries(once.replace(ENGINE, "duckdb-base.0123abcd.wasm")), once);
});

test("an unknown Framework stops with a message", () => {
  assert.throws(() => patchClient("export {}"), /Framework changed/);
  assert.throws(() => patchLibraries("export {}"), /Framework changed/);
});
