// The bucket, through rclone: pull warehouses into the cache, upload site builds.
import {existsSync, mkdirSync} from "node:fs";
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

/** Where a warehouse is cached. */
export function warehouseCache(config, warehouse) {
  return join(cacheDir(), "warehouses", config.cloudflare.bucket, warehouse.r2 === "" ? "_root" : warehouse.r2.replace(/\/$/, ""));
}

/**
 * Copy a warehouse from the bucket into the cache and return its path: parquet/ and tiles/
 * (mirrored), manifest.json and catalog.sql (when there). Nothing else in its folder is read.
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
  }
  for (const f of ["manifest.json", "catalog.sql"]) {
    if (listing.has(f)) run("rclone", ["copyto", "--checksum", `${src}${f}`, join(dest, f)], {quiet: true});
  }
  return dest;
}

/**
 * Folders under the site's bucket folder that hold a page (index.html) but are neither in the
 * new build nor another site: a sync would delete them. Returns their names ("dhis2-sl/").
 */
export function strays(remoteIndexes, distHas, nested) {
  const found = new Set();
  for (const key of remoteIndexes) {
    const slash = key.indexOf("/");
    if (slash < 0) continue;                       // the site's own index.html
    const top = key.slice(0, slash + 1);
    if (nested.some((n) => key.startsWith(n))) continue;
    if (!distHas(top)) found.add(top);
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
    const found = strays(indexes, (top) => existsSync(join(dist, top)), nested);
    if (found.length) {
      throw new Error(`${dest} has pages in ${found.join(", ")} that this build doesn't have and no site in the config owns; `
        + "uploading would delete them. Add those sites to the config, or pass --prune to delete them.");
    }
  }
  console.error(`== upload ${site.name}: ${dist} → ${dest}${dryRun ? " (dry run)" : ""}`);
  const excludes = nested.flatMap((n) => ["--exclude", `/${n}**`]);
  run("rclone", ["sync", ...COPY, ...excludes, ...(dryRun ? ["--dry-run"] : []), "--stats-one-line", "-v", dist, dest]);
}
