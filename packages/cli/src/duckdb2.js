// Run a Framework site's in-browser DuckDB on the DuckDB 2.0 engine.
//
// Framework 1.13 pins DuckDB-Wasm 1.29.0 (the DuckDB 1.1.1 engine) and loads its "mvp"/"eh"
// builds. DuckDB-Wasm for DuckDB 2.0 is not on npm yet, so this takes the package its CI built
// from the v2.0.0 release and puts it where Framework looks:
//
//   1. <site root>/.observablehq/cache/_npm/@duckdb/duckdb-wasm@1.29.0/: the 2.0 module, worker
//      and engine, under the folder name Framework expects.
//   2. @observablehq/framework/dist/client/stdlib/duckdb.js: ask for the new "base" build (2.0
//      renamed mvp/eh to base/threads); and dist/libraries.js, so that `observable build`
//      copies the base files instead of the mvp/eh ones.
//
// Each site's observablehq.config.js also sets duckdb.extensions json and parquet to null: 2.0
// has both built in, and Framework would otherwise bundle the 1.1.1 ones (`observatory check`
// warns when a site doesn't).
//
// Framework puts a content hash in the worker's file name but not the engine's, and hosts tell
// browsers to keep _npm/ files for a year. So the engine is copied in as
// duckdb-base.<first 8 hex of its sha256>.wasm: a different build gets a new name.
//
// npm install and Framework's `clean` undo this, so the CLI applies it before every build and
// preview. Lifted from the ICR's campaignhq/duckdb-wasm2.sh. Drop it once DuckDB-Wasm 2.0 is on
// npm and Framework uses it.
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {run} from "./run.js";

// duckdb/duckdb-wasm CI run on commit 5beed055bc, DuckDB submodule d54cbbe3df (v2.0.0).
export const RUN = "39574007535";
export const BUILD = "d54cbbe3df";
export const SUMS = {
  "duckdb-base.wasm": "be806078a159f7c196ff5065d787c2f558f07e3ad727b21c7aa2b7329e8c50d7",
  "duckdb-browser-base.worker.js": "8a8f73e2860daa0b1b7d4df0a2a017fef33e694249a6634636553478e630f9d5",
  "duckdb-browser.mjs": "35f33368cb6018c1e6ede36273f5fec39e5c86e4976599decda845d5af2d19f5"
};
export const ENGINE = `duckdb-base.${SUMS["duckdb-base.wasm"].slice(0, 8)}.wasm`;
const PINNED = "@duckdb/duckdb-wasm@1.29.0";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const complete = (dir) => Object.entries(SUMS).every(([f, sum]) => existsSync(join(dir, f)) && sha256(join(dir, f)) === sum);

/** The folder holding the three 2.0 files, downloading them (with gh) the first time. */
export function ensureStore() {
  const base = process.env.DUCKDB_WASM2_DIR ?? join(homedir(), ".cache", "observatory", "duckdb-wasm2");
  const store = join(base, BUILD);
  if (complete(store)) return store;
  // The ICR's script kept the same files here.
  const legacy = join(homedir(), ".cache", "duckdb-wasm2", BUILD);
  mkdirSync(store, {recursive: true});
  if (complete(legacy)) {
    for (const f of Object.keys(SUMS)) copyFileSync(join(legacy, f), join(store, f));
    return store;
  }
  console.error(`== downloading DuckDB-Wasm 2.0 (duckdb/duckdb-wasm CI run ${RUN}) to ${store}`);
  const tmp = mkdtempSync(join(tmpdir(), "obs-duckdb-"));
  try {
    run("gh", ["run", "download", RUN, "-R", "duckdb/duckdb-wasm", "-n", "duckdb-wasm-packages", "-D", tmp]);
    run("unzip", ["-q", join(tmp, "duckdb-wasm-packages.zip"), ...Object.keys(SUMS).map((f) => `packages/duckdb-wasm/dist/${f}`), "-d", tmp]);
    for (const f of Object.keys(SUMS)) copyFileSync(join(tmp, "packages/duckdb-wasm/dist", f), join(store, f));
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
  if (!complete(store)) throw new Error(`checksum mismatch in ${store}`);
  return store;
}

/** Whether Framework has cached DuckDB-Wasm and Apache Arrow for the site (it does on the first build). */
export function npmCached(siteRoot) {
  const npm = join(siteRoot, ".observablehq", "cache", "_npm");
  return existsSync(join(npm, PINNED, "_esm.js")) && arrowVersion(npm) !== null;
}

function arrowVersion(npm) {
  if (!existsSync(npm)) return null;
  const versions = readdirSync(npm).filter((d) => d.startsWith("apache-arrow@"));
  versions.sort((a, b) => a.slice(13).localeCompare(b.slice(13), undefined, {numeric: true}));
  return versions.at(-1) ?? null;
}

/** Point Framework's client and its build file list at the base build. Safe to run again. */
export function patchFramework(frameworkDir) {
  const client = join(frameworkDir, "dist", "client", "stdlib", "duckdb.js");
  const libraries = join(frameworkDir, "dist", "libraries.js");
  writeFileSync(client, patchClient(readFileSync(client, "utf8")));
  writeFileSync(libraries, patchLibraries(readFileSync(libraries, "utf8")));
}

export function patchClient(s) {
  const start = s.indexOf("const bundles = {");
  const end = s.indexOf("const bundle = duckdb.selectBundle(bundles);");
  if (start < 0 || end < 0) throw new Error("Framework's stdlib/duckdb.js: DuckDB bundle list not found; Framework changed?");
  return s.slice(0, start) + `const bundles = {
  base: {
    mainModule: import.meta.resolve("npm:@duckdb/duckdb-wasm/dist/${ENGINE}"),
    mainWorker: import.meta.resolve("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js")
  }
};
` + s.slice(end);
}

export function patchLibraries(s) {
  const old = /(\s*)implicits\.add\("npm:@duckdb\/duckdb-wasm\/dist\/duckdb-mvp\.wasm"\);\s*implicits\.add\("npm:@duckdb\/duckdb-wasm\/dist\/duckdb-browser-mvp\.worker\.js"\);\s*implicits\.add\("npm:@duckdb\/duckdb-wasm\/dist\/duckdb-eh\.wasm"\);\s*implicits\.add\("npm:@duckdb\/duckdb-wasm\/dist\/duckdb-browser-eh\.worker\.js"\);/;
  const base = /npm:@duckdb\/duckdb-wasm\/dist\/duckdb-base(\.[0-9a-f]{8})?\.wasm/;
  if (old.test(s)) {
    return s.replace(old, (_, ws) => `${ws}implicits.add("npm:@duckdb/duckdb-wasm/dist/${ENGINE}");${ws}implicits.add("npm:@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js");`);
  }
  if (base.test(s)) return s.replace(base, `npm:@duckdb/duckdb-wasm/dist/${ENGINE}`);
  throw new Error("Framework's libraries.js: DuckDB file list not found; Framework changed?");
}

/**
 * Put the 2.0 engine and worker into the site's Framework npm cache. A patched Framework asks
 * for them by these names, which jsDelivr doesn't have, so they must be there before the
 * site's first build.
 */
export function placeEngine(siteRoot, store) {
  const dist = join(siteRoot, ".observablehq", "cache", "_npm", PINNED, "dist");
  mkdirSync(dist, {recursive: true});
  for (const f of readdirSync(dist)) {
    if (/^duckdb-(mvp|eh)\.wasm$|^duckdb-base.*\.wasm$|^duckdb-browser-(mvp|eh)\.worker\.js$/.test(f)) rmSync(join(dist, f));
  }
  copyFileSync(join(store, "duckdb-base.wasm"), join(dist, ENGINE));
  copyFileSync(join(store, "duckdb-browser-base.worker.js"), join(dist, "duckdb-browser-base.worker.js"));
}

/**
 * Replace the 1.29 module in the site's npm cache with the 2.0 one, importing the Apache Arrow
 * that Framework cached. Needs the cache filled (see npmCached). Returns the Arrow folder.
 */
export function patchSiteCache(siteRoot, store) {
  const npm = join(siteRoot, ".observablehq", "cache", "_npm");
  const cache = join(npm, PINNED);
  const arrow = arrowVersion(npm);
  if (!arrow || !existsSync(join(cache, "_esm.js"))) throw new Error(`${siteRoot}: Framework has not cached DuckDB-Wasm yet`);
  placeEngine(siteRoot, store);
  const module = readFileSync(join(store, "duckdb-browser.mjs"), "utf8")
    .replaceAll('from"apache-arrow"', `from"../../${arrow}/_esm.js"`)
    .replace(/^\/\/# sourceMappingURL.*$/m, "");
  writeFileSync(join(cache, "_esm.js"), `/* DuckDB-Wasm for DuckDB 2.0.0 (${BUILD}), duckdb/duckdb-wasm CI run ${RUN}; applied by observatory */\n${module}`);
  return arrow;
}
