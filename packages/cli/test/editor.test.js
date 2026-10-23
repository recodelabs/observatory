import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {request} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";
import {freePort, option} from "../src/commands.js";
import {pages, previewPath, startEditor} from "../src/editor.js";

let root, server, base, token;
before(async () => {
  root = mkdtempSync(join(tmpdir(), "obs-edit-"));
  for (const [p, text] of [["index.md", "# Home\n"], ["coverage.md", "# Coverage\n"], ["districts/kampala.md", "# Kampala\n"],
    ["_partials/note.md", "x"], [".hidden.md", "x"], ["data/notes.csv", "a,b\n"], ["node_modules/pkg/README.md", "x"]]) {
    mkdirSync(join(root, p, ".."), {recursive: true});
    writeFileSync(join(root, p), text);
  }
  writeFileSync(join(tmpdir(), "obs-edit-outside.md"), "outside\n");
  symlinkSync(join(tmpdir(), "obs-edit-outside.md"), join(root, "link.md"));
  const port = await freePort(4500);
  server = await startEditor({name: "uganda", root, previewUrl: "http://127.0.0.1:3000/", port});
  base = `http://127.0.0.1:${port}`;
  token = (await (await fetch(base + "/edit/coverage")).text()).match(/data-token="([0-9a-f]{32})"/)[1];
});
after(() => {
  server.close();
  rmSync(root, {recursive: true, force: true});
  rmSync(join(tmpdir(), "obs-edit-outside.md"), {force: true});
});

const save = (page, body, headers = {}) => fetch(`${base}/save/${page}`, {method: "POST",
  headers: {"content-type": "application/json", "x-observatory-token": token, ...headers}, body: JSON.stringify(body)});
const baseOf = async (page) => (await (await fetch(`${base}/edit/${page}`)).text()).match(/data-base="([0-9a-f]{40})"/)[1];

test("lists the site's pages like Framework, without symlinks or node_modules", () => {
  assert.deepEqual(pages(root), ["coverage.md", "districts/kampala.md", "index.md"]);
  assert.equal(previewPath("index.md"), "/");
  assert.equal(previewPath("districts/index.md"), "/districts/");
  assert.equal(previewPath("districts/kampala.md"), "/districts/kampala");
});

test("shows a page's Markdown beside its preview", async () => {
  const html = await (await fetch(base + "/edit/districts/kampala")).text();
  assert.match(html, /\n# Kampala\n<\/textarea>/);
  assert.match(html, /<iframe src="http:\/\/127\.0\.0\.1:3000\/districts\/kampala"/);
  const list = await (await fetch(base + "/")).text();
  assert.match(list, /href="\/edit\/districts\/kampala"/);
  assert.doesNotMatch(list, /link\.md|note\.md|notes\.csv|README/);
});

test("saves to disk, and refuses anything not on the list", async () => {
  const res = await save("coverage", {text: "# Coverage\n\nMore.\n", base: await baseOf("coverage")});
  assert.equal(res.status, 200);
  assert.equal(readFileSync(join(root, "coverage.md"), "utf8"), "# Coverage\n\nMore.\n");
  for (const p of ["link", "_partials/note", "nope", "..%2Findex", "districts%2Fkampala", "%2E%2E/index", "%zz"]) {
    assert.equal((await save(p, {text: "x", base: "0".repeat(40)})).status, 404, p);
    assert.equal((await fetch(`${base}/edit/${p}`)).status, 404, p);
  }
  assert.equal(readFileSync(join(tmpdir(), "obs-edit-outside.md"), "utf8"), "outside\n");
});

test("refuses saves without this run's token, from another origin or for another host", async () => {
  const b = await baseOf("index");
  assert.equal((await save("index", {text: "x", base: b}, {"x-observatory-token": "0".repeat(32)})).status, 403);
  assert.equal((await save("index", {text: "x", base: b}, {origin: "https://evil.example"})).status, 403);
  const status = await new Promise((done) => {
    const req = request(`${base}/save/index`, {method: "POST", headers: {host: "evil.example", "x-observatory-token": token, "content-type": "application/json"}},
      (res) => { res.resume(); done(res.statusCode); });
    req.end(JSON.stringify({text: "x", base: b}));
  });
  assert.equal(status, 421);
  assert.equal(readFileSync(join(root, "index.md"), "utf8"), "# Home\n");
});

test("won't overwrite a change made on disk by another editor", async () => {
  const b = await baseOf("index");
  writeFileSync(join(root, "index.md"), "# Home, from another editor\n");
  const res = await save("index", {text: "# Mine\n", base: b});
  assert.equal(res.status, 409);
  assert.equal(readFileSync(join(root, "index.md"), "utf8"), "# Home, from another editor\n");
});

test("reads --port and --host in either form", () => {
  assert.equal(option(["--port", "4100"], "--port"), "4100");
  assert.equal(option(["--port=4100", "--host=0.0.0.0"], "--port"), "4100");
  assert.equal(option(["--port=4100", "--host=0.0.0.0"], "--host"), "0.0.0.0");
  assert.equal(option(["--no-open"], "--port"), null);
});

test("doesn't follow a page swapped for a symlink, and reports a missing file instead of failing", async () => {
  const b = await baseOf("districts/kampala");
  rmSync(join(root, "districts/kampala.md"));
  symlinkSync(join(tmpdir(), "obs-edit-outside.md"), join(root, "districts/kampala.md"));
  assert.equal((await save("districts/kampala", {text: "pwned\n", base: b})).status, 404);
  assert.equal(readFileSync(join(tmpdir(), "obs-edit-outside.md"), "utf8"), "outside\n");
  rmSync(join(root, "districts/kampala.md"));
  writeFileSync(join(root, "districts/kampala.md"), "# Kampala\n");
  // The editor keeps running after a request fails.
  assert.equal((await fetch(base + "/")).status, 200);
});
