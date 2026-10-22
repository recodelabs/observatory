import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {test} from "node:test";
import {normalize} from "../src/config.js";
import {pull, strays, upload, warehouseCache} from "../src/r2.js";

test("strays: index pages the build lacks and no site owns, at any depth", () => {
  const remote = ["index.html", "ug/index.html", "dhis2-sl/index.html", "coverage/index.html", "reports/legacy/index.html", "ug/x/index.html"];
  const dist = new Set(["coverage/index.html", "reports/current.html"]);
  const has = (k) => dist.has(k);
  assert.deepEqual(strays(remote, has, ["ug/"]), ["dhis2-sl/", "reports/legacy/"]);
  assert.deepEqual(strays(remote, has, ["ug/", "dhis2-sl/", "reports/legacy/"]), []);
});

test("warehouse caches are kept apart by remote, bucket and folder", () => {
  const c = (rclone) => normalize({cloudflare: {bucket: "icr", rclone}, warehouses: {a: {r2: ""}, b: {r2: "_root/"}}, sites: []}, "/r");
  const root = warehouseCache(c("r2"), c("r2").warehouses.a);
  assert.notEqual(root, warehouseCache(c("r2"), c("r2").warehouses.b));
  assert.notEqual(root, warehouseCache(c("other"), c("other").warehouses.a));
});

const hasRclone = spawnSync("rclone", ["version"]).status === 0;

test("pull and upload against a local rclone remote", {skip: !hasRclone && "rclone not installed"}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "obs-r2-"));
  const put = (p, text = p) => { mkdirSync(dirname(join(tmp, p)), {recursive: true}); writeFileSync(join(tmp, p), text); };
  const env = {...process.env, RCLONE_CONFIG_OBSTEST_TYPE: "local", OBSERVATORY_CACHE: join(tmp, "cache")};
  const saved = process.env;
  process.env = env;
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    put("bucket/uga/parquet/locations/country=UG/part-0.parquet", "rows");
    put("bucket/uga/parquet/README.md", "producer notes");
    put("bucket/uga/manifest.json", "{}");
    put("bucket/uga/other.txt", "not pulled");
    put("bucket/_site/ug/index.html", "uganda");
    put("bucket/_site/legacy/index.html", "unknown site");
    put("bucket/_site/reports/legacy/index.html", "unknown nested site");
    put("bucket/_site/old.html", "removed page");
    const c = normalize({
      cloudflare: {bucket: "bucket", rclone: "obstest", sites: "_site/"},
      warehouses: {uga: {r2: "uga/"}},
      sites: [{name: "main", path: "/", dir: "main"}, {name: "uganda", path: "/ug/", dir: "uganda", warehouse: "uga"}]
    }, tmp);

    const dest = pull(c, c.warehouses.uga);
    assert.equal(readFileSync(join(dest, "parquet/locations/country=UG/part-0.parquet"), "utf8"), "rows");
    assert.ok(existsSync(join(dest, "manifest.json")));
    assert.ok(!existsSync(join(dest, "tiles")));
    assert.ok(!existsSync(join(dest, "other.txt")));
    // Contract files the bucket no longer has leave the cache.
    put("bucket/uga/tiles/admin.pmtiles", "tiles");
    put("bucket/uga/catalog.sql", "views");
    pull(c, c.warehouses.uga);
    assert.ok(existsSync(join(dest, "tiles/admin.pmtiles")) && existsSync(join(dest, "catalog.sql")));
    rmSync(join(tmp, "bucket/uga/tiles"), {recursive: true});
    rmSync(join(tmp, "bucket/uga/catalog.sql"));
    pull(c, c.warehouses.uga);
    assert.ok(!existsSync(join(dest, "tiles")) && !existsSync(join(dest, "catalog.sql")));

    put("main/dist/index.html", "main");
    put("main/dist/reports/current.html", "a page beside the unknown nested site");
    assert.throws(() => upload(c, c.sites[0], join(tmp, "main/dist")), /legacy\/, reports\/legacy\/.*--prune/);
    rmSync(join(tmp, "bucket/_site/legacy"), {recursive: true});
    assert.throws(() => upload(c, c.sites[0], join(tmp, "main/dist")), /reports\/legacy\/.*--prune/);
    rmSync(join(tmp, "bucket/_site/reports"), {recursive: true});
    upload(c, c.sites[0], join(tmp, "main/dist"));
    assert.equal(readFileSync(join(tmp, "bucket/_site/index.html"), "utf8"), "main");
    assert.equal(readFileSync(join(tmp, "bucket/_site/ug/index.html"), "utf8"), "uganda", "the nested site is left alone");
    assert.ok(!existsSync(join(tmp, "bucket/_site/old.html")), "the site's own removed pages go");
  } finally {
    process.chdir(cwd);
    process.env = saved;
    rmSync(tmp, {recursive: true, force: true});
  }
});
