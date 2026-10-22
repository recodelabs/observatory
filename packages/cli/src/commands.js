// The observatory commands.
import {cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {precompress} from "./brotli.js";
import {accessLevel, findConfig, loadConfig, nestedSites, normalize, selectSites, siteFolder, validate, CONFIG_FILE} from "./config.js";
import {ensureStore, npmCached, patchFramework, patchSiteCache, placeEngine} from "./duckdb2.js";
import {framework, siteConfig, siteConfigFile, siteOutput, siteRoot} from "./framework.js";
import {checkBucket, pull as pullWarehouse, upload, warehouseCache} from "./r2.js";
import {run, serve} from "./run.js";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "template");

/**
 * The warehouse folder a site's loaders read (as DATA), or null when the site has none (its
 * loaders use their own default). `local`: the warehouse's local copy; `pull`: copy it from
 * the bucket now; otherwise the cached copy, pulled when there is none.
 */
function dataFor(config, site, {local = false, pull = false} = {}) {
  if (!site.warehouse) return null;
  const w = config.warehouses[site.warehouse];
  if (local) {
    if (!w.local) throw new Error(`warehouse ${w.name} has no local copy in the config (warehouses.${w.name}.local)`);
    if (!existsSync(join(w.local, "parquet"))) throw new Error(`${w.local}: no parquet/ (refresh the warehouse first)`);
    return w.local;
  }
  const cached = warehouseCache(config, w);
  if (pull || !existsSync(join(cached, "parquet"))) return pullWarehouse(config, w);
  return cached;
}

function siteEnv(data) {
  // DuckDB's CLI prints a banner into loader output when it thinks an AI agent runs it.
  const env = {...process.env, DUCKDB_AGENT_MODE: "0"};
  if (data) env.DATA = data;
  return env;
}

// Framework's own entries in a site's cache: imported packages, its client bundles, the build
// record. Everything else there is a data loader's output.
const FRAMEWORK_CACHE = new Set(["_npm", "_node", "_jsr", "_observablehq", "_build.json"]);

/** Remove the data loaders' cached outputs from the site's Framework cache, wherever the loaders are. */
export function clearLoaderCache(root) {
  const cache = join(root, ".observablehq", "cache");
  if (!existsSync(cache)) return;
  for (const e of readdirSync(cache)) {
    if (!FRAMEWORK_CACHE.has(e)) rmSync(join(cache, e), {recursive: true, force: true});
  }
}

/** Whether any page or module of the site uses DuckDB (sql front matter or blocks, DuckDBClient). */
export function usesDuckDB(root) {
  const pattern = /^sql:|^```sql\b|\bDuckDBClient\b|\bsql`/m;
  const scan = (dir) => readdirSync(dir, {withFileTypes: true}).some((e) => {
    if (e.name.startsWith(".")) return false;   // Framework's cache
    const p = join(dir, e.name);
    if (e.isDirectory()) return scan(p);
    return /\.(md|js|ts|jsx|tsx)$/.test(e.name) && pattern.test(readFileSync(p, "utf8"));
  });
  return existsSync(root) && scan(root);
}

/**
 * Put DuckDB 2.0 into Framework and the site's npm cache. When the cache is empty, the site is
 * built once first to fill it. Returns Framework, and whether that first build was made.
 */
async function duckdb2(site, env) {
  const fw = framework(site.dir);
  const root = await siteRoot(site.dir);
  if (!usesDuckDB(root)) return {fw, built: false};
  if (!fw.version.startsWith("1.13.")) console.error(`warning: DuckDB 2.0 patch is made for Framework 1.13; ${site.name} has ${fw.version}`);
  const store = ensureStore();
  patchFramework(fw.dir);
  let built = false;
  if (!npmCached(root)) {
    placeEngine(root, store);
    console.error(`== ${site.name}: first build, to fill Framework's npm cache`);
    run(process.execPath, [fw.bin, "build"], {cwd: site.dir, env});
    built = true;
    if (!npmCached(root)) throw new Error(`${site.name}: Framework did not cache DuckDB-Wasm in its first build`);
  }
  const arrow = patchSiteCache(root, store);
  console.error(`== ${site.name}: DuckDB-Wasm 2.0 (arrow ${arrow.slice(13)})`);
  return {fw, built};
}

export async function newSite([name], {dir}) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("usage: observatory new <name>  (lowercase letters, digits and -)");
  const file = findConfig();
  const base = file ? dirname(file) : process.cwd();
  const target = resolve(base, dir ?? join("sites", name));
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} exists and is not empty`);
  cpSync(TEMPLATE, target, {recursive: true});
  // npm leaves .gitignore files out of packages, so the template's is kept as gitignore.
  renameSync(join(target, "gitignore"), join(target, ".gitignore"));
  console.log(`created ${relative(process.cwd(), target) || "."}`);
  console.log(`\nAdd it to ${file ? relative(process.cwd(), file) : CONFIG_FILE}'s sites:\n`);
  console.log(`  {name: "${name}", path: "/${name}/", dir: "${relative(base, target)}", warehouse: "<a warehouse>"}`);
  console.log(`\nWith no \`access\`, only signed-in users can see it. Then: observatory dev ${name}`);
}

export async function dev([name, ...rest], opts) {
  const config = await loadConfig();
  if (!name) throw new Error(`usage: observatory dev <site>  (sites: ${config.sites.map((s) => s.name).join(", ")})`);
  const [site] = selectSites(config, [name]);
  const data = dataFor(config, site, opts);
  const env = siteEnv(data);
  const {fw} = await duckdb2(site, env);
  if (data) console.error(`== ${site.name}: data from ${data}`);
  const code = await serve(process.execPath, [fw.bin, "preview", ...rest], {cwd: site.dir, env});
  process.exitCode = code;
}

export async function pull(names) {
  const config = await loadConfig();
  checkBucket(config);
  const warehouses = new Set(selectSites(config, names).map((s) => s.warehouse).filter(Boolean));
  for (const w of warehouses) console.log(pullWarehouse(config, config.warehouses[w]));
}

/** Build each site from fresh data. Returns the sites built. */
export async function build(names, opts) {
  const config = await loadConfig();
  const sites = selectSites(config, names);
  if (!opts.local && sites.some((s) => s.warehouse)) checkBucket(config);
  for (const site of sites) {
    const data = dataFor(config, site, {local: opts.local, pull: !opts.local});
    const env = siteEnv(data);
    // Framework reuses a loader's cached output until the loader file changes, so new data in the
    // warehouse would not show: drop the cached outputs.
    clearLoaderCache(await siteRoot(site.dir));
    const {fw} = await duckdb2(site, env);
    console.error(`== build ${site.name}${data ? ` from ${data}` : ""}`);
    run(process.execPath, [fw.bin, "build"], {cwd: site.dir, env});
    await precompress(await siteOutput(site.dir));
  }
  return {config, sites};
}

export async function deploy(names, opts) {
  let config, sites;
  if (opts.skipBuild) {
    config = await loadConfig();
    sites = selectSites(config, names);
  } else {
    ({config, sites} = await build(names, opts));
  }
  checkBucket(config);
  const outputs = new Map();
  for (const site of sites) {
    const dist = await siteOutput(site.dir);
    if (!existsSync(join(dist, "index.html"))) throw new Error(`${site.name}: no build in ${dist}`);
    outputs.set(site, dist);
  }
  for (const site of sites) upload(config, site, outputs.get(site), {dryRun: opts.dryRun, prune: opts.prune});
  // The host goes last, so a wrangler failure never leaves a site un-uploaded. A gate's database
  // is migrated first, so the new Worker never runs against an old schema.
  const {worker, d1} = config.cloudflare;
  if (worker && opts.worker !== false) {
    const where = relative(config.root, worker) || ".";
    if (d1) {
      console.error(`== D1 ${d1}: ${opts.dryRun ? "pending migrations" : "apply migrations"} (${where})`);
      run("npx", ["wrangler", "d1", "migrations", opts.dryRun ? "list" : "apply", d1, "--remote"], {cwd: worker});
    }
    if (!opts.dryRun) {
      console.error(`== deploy ${where} (wrangler)`);
      run("npx", ["wrangler", "deploy"], {cwd: worker});
    }
  }
  for (const site of sites) console.log(`${config.host ?? ""}${site.path}`);
}

/** Check the config and each site; print what each site serves to whom. Exit 1 on a problem. */
export async function check() {
  const file = findConfig();
  if (!file) throw new Error(`no ${CONFIG_FILE} here or in a folder above`);
  const config = normalize((await import(pathToFileURL(file).href)).default, dirname(file));
  const errors = validate(config);
  const warnings = [];
  for (const site of config.sites) {
    if (!site.dir || !site.name) continue;
    if (!siteConfigFile(site.dir)) { errors.push(`${site.name}: no observablehq.config.js in ${site.dir}`); continue; }
    const fc = await siteConfig(site.dir);
    const ext = fc.duckdb?.extensions ?? {};
    if (ext.json !== null || ext.parquet !== null) {
      warnings.push(`${site.name}: set duckdb: {extensions: {json: null, parquet: null}} in observablehq.config.js (DuckDB 2.0 has both built in)`);
    }
    if (fc.search && accessLevel(site) !== "public") warnings.push(`${site.name}: search is on; its index holds every page's text`);
    if (site.warehouse && config.warehouses[site.warehouse]?.local && !existsSync(config.warehouses[site.warehouse].local)) {
      warnings.push(`${site.name}: warehouse ${site.warehouse}'s local copy ${config.warehouses[site.warehouse].local} does not exist`);
    }
  }
  if (!errors.length) {
    const rows = config.sites.map((s) => [s.name, s.path, accessLevel(s), s.warehouse ?? "(local data)", siteFolder(config, s),
      nestedSites(config, s).join(" ") || ""]);
    const head = ["site", "path", "access", "warehouse", "uploads to", "leaves alone"];
    const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    for (const r of [head, ...rows]) console.log(r.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd());
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  if (errors.length) process.exitCode = 1;
}
