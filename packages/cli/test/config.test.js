import assert from "node:assert/strict";
import {test} from "node:test";
import {accessLevel, nestedSites, normalize, selectSites, siteFolder, validate} from "../src/config.js";

const raw = {
  cloudflare: {bucket: "icr", sites: "_site/campaignhq/"},
  warehouses: {main: {r2: ""}, uga: {r2: "uga/", local: "../country/uganda/warehouse"}},
  sites: [
    {name: "main", path: "/", dir: "sites/main", warehouse: "main", access: "public"},
    {name: "uganda", path: "/ug/", dir: "sites/uganda", warehouse: "uga", access: [{oidc: "uga", group: "/dashboards"}]},
    {name: "sldash", path: "/dhis2-sl/", dir: "sites/sldash"}
  ]
};

test("normalize resolves folders and fills defaults", () => {
  const c = normalize(raw, "/repo/dashboards");
  assert.equal(c.cloudflare.rclone, "r2");
  assert.equal(c.sites[0].dir, "/repo/dashboards/sites/main");
  assert.equal(c.warehouses.uga.local, "/repo/country/uganda/warehouse");
  assert.equal(c.warehouses.main.local, null);
  assert.equal(c.sites[2].warehouse, null);
  assert.deepEqual(validate(c), []);
});

test("sites upload to the sites folder plus their path, and leave nested sites alone", () => {
  const c = normalize(raw, "/r");
  assert.equal(siteFolder(c, c.sites[0]), "_site/campaignhq/");
  assert.equal(siteFolder(c, c.sites[1]), "_site/campaignhq/ug/");
  assert.deepEqual(nestedSites(c, c.sites[0]), ["ug/", "dhis2-sl/"]);
  assert.deepEqual(nestedSites(c, c.sites[1]), []);
});

test("access defaults to signed-in", () => {
  const c = normalize(raw, "/r");
  assert.deepEqual(c.sites.map(accessLevel), ["public", "restricted", "signed-in"]);
});

test("validate reports each problem", () => {
  const bad = normalize({
    cloudflare: {bucket: "X", sites: "_site"},
    warehouses: {a: {r2: "a"}, b: {r2: "../b/"}, c: {r2: "_site/c/"}},
    sites: [
      {name: "Main", path: "/", dir: "m"},
      {name: "x", path: "/x", dir: "x", warehouse: "nope"},
      {name: "y", path: "/", warehouse: "a", access: "everyone"},
      {name: "y", path: "/../", dir: "y"}
    ]
  }, "/r");
  const errors = validate(bad).join("\n");
  for (const want of ["cloudflare.bucket", "cloudflare.sites", "warehouses.a.r2", "warehouses.b.r2", "warehouses.c.r2: overlaps",
    "sites[0] (Main).name", "sites[1] (x).path", "sites[1] (x).warehouse", "sites[2] (y).path: used twice", "sites[2] (y).dir",
    "sites[2] (y).access", "sites[3] (y).name: used twice", "sites[3] (y).path"]) {
    assert.ok(errors.includes(want), `missing: ${want}\n${errors}`);
  }
});

test("selectSites keeps config order and rejects unknown names", () => {
  const c = normalize(raw, "/r");
  assert.deepEqual(selectSites(c, ["uganda", "main"]).map((s) => s.name), ["main", "uganda"]);
  assert.equal(selectSites(c, []).length, 3);
  assert.throws(() => selectSites(c, ["ug"]), /no site named ug/);
});

test("cloudflare.d1 needs a worker folder and a plain name", () => {
  const base = {cloudflare: {bucket: "icr"}, warehouses: {}, sites: [{name: "a", path: "/", dir: "a"}]};
  assert.deepEqual(validate(normalize({...base, cloudflare: {bucket: "icr", d1: "observatory", worker: "gate"}}, "/r")), []);
  const errors = validate(normalize({...base, cloudflare: {bucket: "icr", d1: "bad name"}}, "/r")).join("\n");
  assert.match(errors, /cloudflare.d1: a D1 database name/);
  assert.match(errors, /cloudflare.d1: needs cloudflare.worker/);
});
