// The bucket, through rclone: pull warehouses into the cache, upload site builds.
import {existsSync, mkdirSync, rmSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {nestedSites, siteFolder} from "./config.js";
import {output, run} from "./run.js";

const COPY = ["--checksum", "--fast-list", "--transfers", "16", "--exclude", ".DS_Store"];

export function cacheDir() {
  return process.env.OBSERVATORY_CACHE ?? join(homedir(), ".cache", "observatory");
}

const remote = (config, folder) => `${config.cloudflare.rclone}:${config.cloudflare.bucket}/${folder}`;

/** Stop early when the rclone remote or the bucket is missing. */
export function checkBucket(config) {
  const {rclone, bucket} = config.cloudflare;
  let buckets;
  try {
    buckets = output("rclone", ["lsf", "--dirs-only", `${rclone}:`]).split("\n").map((l) => l.replace(/\/$/, ""));
  } catch (e) {
    throw new Error(`rclone remote ${rclone}: is not set up (rclone config): ${e.message}`);
  }
  if (!buckets.includes(bucket)) throw new Error(`bucket ${bucket} not found on rclone remote ${rclone}:`);
}

/**
 * Where a warehouse is cached: by rclone remote, bucket and folder. The bucket root is "@root",
 * which no folder name can be (see FOLDER in config.js).
 */
export function warehouseCache(config, warehouse) {
  const {rclone, bucket} = config.cloudflare;
  return join(cacheDir(), "warehouses", rclone, bucket, warehouse.r2 === "" ? "@root" : warehouse.r2.replace(/\/$/, ""));
}

/**
 * Copy a warehouse from the bucket into the cache and return its path: parquet/ and tiles/
 * (mirrored), manifest.json and catalog.sql. Any of these the bucket no longer has is removed
 * from the cache. Nothing else in the warehouse folder is read.
 */
export function pull(config, warehouse) {
  const dest = warehouseCache(config, warehouse);
  const src = remote(config, warehouse.r2);
  const listing = new Set(output("rclone", ["lsf", "--max-depth", "1", src]).split("\n").filter(Boolean));
  if (!listing.has("parquet/")) throw new Error(`warehouse ${warehouse.name}: no parquet/ in ${src}`);
  console.error(`== pull ${src} → ${dest}`);
  mkdirSync(dest, {recursive: true});
  for (const d of ["parquet", "tiles"]) {
    if (listing.has(`${d}/`)) run("rclone", ["sync", ...COPY, `${src}${d}`, join(dest, d)], {quiet: true});
    else rmSync(join(dest, d), {recursive: true, force: true});
  }
  for (const f of ["manifest.json", "catalog.sql"]) {
    if (listing.has(f)) run("rclone", ["copyto", "--checksum", `${src}${f}`, join(dest, f)], {quiet: true});
    else rmSync(join(dest, f), {force: true});
  }
  return dest;
}

/**
 * Folders under the site's bucket folder whose index.html the new build doesn't have and that no
 * other site owns: a sync would delete them, and they may be a site missing from the config.
 * Returns the folders ("dhis2-sl/", "reports/legacy/").
 */
export function strays(remoteIndexes, distHas, nested) {
  const found = new Set();
  for (const key of remoteIndexes) {
    if (!key.endsWith("/index.html")) continue;     // the site's own index.html
    if (nested.some((n) => key.startsWith(n))) continue;
    if (!distHas(key)) found.add(key.slice(0, -"index.html".length));
  }
  return [...found].sort();
}

/**
 * Mirror a site's build (dist/) to its bucket folder. Other sites under its path are left alone;
 * a folder that holds pages and belongs to no configured site stops the upload unless `prune`.
 */
export function upload(config, site, dist, {dryRun = false, prune = false} = {}) {
  const folder = siteFolder(config, site);
  const dest = remote(config, folder);
  const nested = nestedSites(config, site);
  if (!prune) {
    const indexes = output("rclone", ["lsf", "-R", "--files-only", "--include", "**/index.html", dest]).split("\n").filter(Boolean);
    const found = strays(indexes, (key) => existsSync(join(dist, key)), nested);
    if (found.length) {
      throw new Error(`${dest} has index pages in ${found.join(", ")} that this build doesn't have and no site in the config owns; `
        + "uploading would delete them. Add those sites to the config, or pass --prune to delete them.");
    }
  }
  console.error(`== upload ${site.name}: ${dist} → ${dest}${dryRun ? " (dry run)" : ""}`);
  const excludes = nested.flatMap((n) => ["--exclude", `/${n}**`]);
  run("rclone", ["sync", ...COPY, ...excludes, ...(dryRun ? ["--dry-run"] : []), "--stats-one-line", "-v", dist, dest]);
}
