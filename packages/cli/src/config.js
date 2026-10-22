// observatory.config.js: find it, load it, check it, and work out each site's folders.
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

export const CONFIG_FILE = "observatory.config.js";

/** The config file in dir or the nearest folder above it, or null. */
export function findConfig(dir = process.cwd()) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const f = join(d, CONFIG_FILE);
    if (existsSync(f)) return f;
    if (dirname(d) === d) return null;
  }
}

/** Load and normalize the config; throws with every problem found. */
export async function loadConfig(file = findConfig()) {
  if (!file) throw new Error(`no ${CONFIG_FILE} here or in a folder above`);
  const mod = await import(pathToFileURL(file).href);
  const config = normalize(mod.default, dirname(file));
  const errors = validate(config);
  if (errors.length) throw new Error(`${file}:\n  ${errors.join("\n  ")}`);
  return config;
}

/** Fill in defaults and resolve folders against the config's own folder. */
export function normalize(raw, root) {
  if (!raw || typeof raw !== "object") throw new Error(`${CONFIG_FILE} must export a config object as its default`);
  const cf = raw.cloudflare ?? {};
  const warehouses = {};
  for (const [name, w] of Object.entries(raw.warehouses ?? {})) {
    warehouses[name] = {name, r2: w?.r2, local: w?.local ? resolve(root, w.local) : null};
  }
  return {
    ...raw,
    root,
    cloudflare: {...cf, rclone: cf.rclone ?? "r2", sites: cf.sites ?? "_site/", worker: cf.worker ? resolve(root, cf.worker) : null,
      d1: cf.d1 ?? null},
    warehouses,
    sites: (raw.sites ?? []).map((s) => ({...s, dir: s?.dir ? resolve(root, s.dir) : null, warehouse: s?.warehouse ?? null}))
  };
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
// A bucket folder: empty (the bucket root) or segments of safe characters, ending in "/".
const FOLDER = /^(?:[A-Za-z0-9_.-]+\/)*$/;
const PATH = /^\/(?:[A-Za-z0-9_.-]+\/)*$/;

/** Every problem with a normalized config, as messages; empty when it is fine. */
export function validate(c) {
  const errors = [];
  const cf = c.cloudflare;
  if (!cf.bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cf.bucket)) errors.push("cloudflare.bucket: an R2 bucket name is required");
  if (!FOLDER.test(cf.sites) || cf.sites === "" || cf.sites.split("/").includes("..")) errors.push(`cloudflare.sites: a folder in the bucket ending in "/" (got ${JSON.stringify(cf.sites)})`);
  if (!/^[A-Za-z0-9_-]+$/.test(cf.rclone)) errors.push(`cloudflare.rclone: an rclone remote name (got ${JSON.stringify(cf.rclone)})`);
  if (cf.d1 !== null && !/^[A-Za-z0-9_-]+$/.test(cf.d1)) errors.push(`cloudflare.d1: a D1 database name (got ${JSON.stringify(cf.d1)})`);
  if (cf.d1 !== null && !cf.worker) errors.push("cloudflare.d1: needs cloudflare.worker, the folder whose wrangler config binds it");
  for (const w of Object.values(c.warehouses)) {
    if (typeof w.r2 !== "string" || !FOLDER.test(w.r2) || w.r2.split("/").includes("..")) {
      errors.push(`warehouses.${w.name}.r2: "" for the bucket root, or a folder ending in "/" (got ${JSON.stringify(w.r2)})`);
    } else if (w.r2 !== "" && (w.r2.startsWith(cf.sites) || cf.sites.startsWith(w.r2))) {
      // A warehouse at the bucket root is fine: only its parquet/ and tiles/ are pulled.
      errors.push(`warehouses.${w.name}.r2: overlaps the sites folder ${cf.sites}`);
    }
  }
  if (!c.sites.length) errors.push("sites: at least one site is required");
  const names = new Set(), paths = new Set();
  for (const [i, s] of c.sites.entries()) {
    const at = `sites[${i}]${s.name ? ` (${s.name})` : ""}`;
    if (!NAME.test(s.name ?? "")) errors.push(`${at}.name: lowercase letters, digits and -`);
    else if (names.has(s.name)) errors.push(`${at}.name: used twice`);
    names.add(s.name);
    if (!PATH.test(s.path ?? "") || s.path.split("/").includes("..")) errors.push(`${at}.path: starts and ends with "/" (got ${JSON.stringify(s.path)})`);
    else if (paths.has(s.path)) errors.push(`${at}.path: used twice`);
    paths.add(s.path);
    if (!s.dir) errors.push(`${at}.dir: the site's folder is required`);
    if (s.warehouse !== null && !c.warehouses[s.warehouse]) errors.push(`${at}.warehouse: no warehouse named ${JSON.stringify(s.warehouse)}`);
    if (s.access !== undefined && s.access !== "public" && s.access !== "signed-in" && !Array.isArray(s.access)) {
      errors.push(`${at}.access: "public", "signed-in" or a list of rules`);
    }
  }
  return errors;
}

/** The sites named, in config order; all of them when none are named. */
export function selectSites(config, names) {
  if (!names.length) return config.sites;
  const unknown = names.filter((n) => !config.sites.some((s) => s.name === n));
  if (unknown.length) throw new Error(`no site named ${unknown.join(", ")} (sites: ${config.sites.map((s) => s.name).join(", ")})`);
  return config.sites.filter((s) => names.includes(s.name));
}

/** The bucket folder a site is uploaded to: the sites folder plus the site's path. */
export function siteFolder(config, site) {
  return config.cloudflare.sites + site.path.slice(1);
}

/** The other sites served under this one's path, as folders relative to it ("ug/"). */
export function nestedSites(config, site) {
  return config.sites
    .filter((t) => t !== site && t.path.startsWith(site.path))
    .map((t) => t.path.slice(site.path.length));
}

/** Who may see a site: "public", "signed-in" (the default), or "restricted" (rules). */
export function accessLevel(site) {
  if (site.access === "public") return "public";
  if (site.access === undefined || site.access === "signed-in") return "signed-in";
  return "restricted";
}
