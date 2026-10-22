import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {test} from "node:test";
import {normalize} from "../src/config.js";
import {pull, strays, upload} from "../src/r2.js";

test("strays: page folders the build lacks and no site owns", () => {
  const remote = ["index.html", "ug/index.html", "dhis2-sl/index.html", "old/index.html", "old/deep/index.html", "coverage/index.html"];
  const dist = new Set(["coverage/"]);
  assert.deepEqual(strays(remote, (d) => dist.has(d), ["ug/"]), ["dhis2-sl/", "old/"]);
  assert.deepEqual(strays(remote, (d) => dist.has(d), ["ug/", "dhis2-sl/", "old/"]), []);
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

    put("main/dist/index.html", "main");
    assert.throws(() => upload(c, c.sites[0], join(tmp, "main/dist")), /legacy\/.*--prune/);
    rmSync(join(tmp, "bucket/_site/legacy"), {recursive: true});
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
