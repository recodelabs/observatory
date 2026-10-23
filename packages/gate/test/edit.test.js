import {env} from "cloudflare:workers";
import {afterAll, beforeAll, beforeEach, describe, it, expect} from "vitest";
import {createApp, editLink} from "../src/index.js";
import {loadConfig} from "../src/config.js";
import {csrfToken} from "../src/pages/csrf.js";
import {CONFIG, NAV, putSite, signUp, verify} from "./helpers.js";

// The suite's config with a repo and a folder for the "ug" site: its pages are
// dashboards/sites/uganda/src/*.md in recodelabs/icr on main. A fake GitHub stands in for
// api.github.com below.
const EDIT_CONFIG = {...CONFIG, repo: {github: "recodelabs/icr", branch: "main", root: "dashboards", app: 12345},
  sites: CONFIG.sites.map((s) => s.name === "ug" ? {...s, dir: "sites/uganda"} : s)};
const app = createApp(EDIT_CONFIG);
const FOLDER = "dashboards/sites/uganda/src";

let keys, ENV;
const call = (path, init = {}) => app.fetch(new Request("http://example.com" + path, init), ENV);
const sha1 = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...bytes)).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;

// The fake repo: path → text. Every request is recorded with its token.
const github = {files: new Map(), requests: [], down: false};
async function resetRepo() {
  github.files = new Map([
    [`${FOLDER}/index.md`, "# Uganda\n\nThe overview.\n"],
    [`${FOLDER}/coverage.md`, "# Coverage\n"],
    [`${FOLDER}/districts/kampala.md`, "# Kampala\n"],
    [`${FOLDER}/data/notes.csv`, "a,b\n"]
  ]);
  github.requests = [];
  github.down = false;
}

async function verifyJwt(jwt) {
  const [head, body, sig] = jwt.split(".");
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, dec(sig), new TextEncoder().encode(`${head}.${body}`));
  return ok ? JSON.parse(new TextDecoder().decode(dec(body))) : null;
}

const realFetch = globalThis.fetch;
beforeAll(async () => {
  keys = await crypto.subtle.generateKey({name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"}, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  ENV = {...env, GITHUB_APP_PRIVATE_KEY: pem("PRIVATE KEY", pkcs8)};
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.origin !== "https://api.github.com") return realFetch(input, init);
    const token = (init.headers?.authorization ?? "").replace(/^Bearer /, "");
    const body = init.body ? JSON.parse(init.body) : null;
    github.requests.push({method: init.method ?? "GET", path: url.pathname, token, body});
    const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {"content-type": "application/json"}});
    if (github.down) return json({message: "Server Error"}, 500);
    const repo = "/repos/recodelabs/icr";
    if (url.pathname === `${repo}/installation`) {
      const claims = await verifyJwt(token);
      return claims?.iss === "12345" && claims.exp > claims.iat ? json({id: 7}) : json({message: "Bad credentials"}, 401);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      if (!(await verifyJwt(token))) return json({message: "Bad credentials"}, 401);
      expect(body).toEqual({repositories: ["icr"], permissions: {contents: "write"}});
      return json({token: "ghs_installation", expires_at: new Date(Date.now() + 3600e3).toISOString()}, 201);
    }
    if (token !== "ghs_installation") return json({message: "Bad credentials"}, 401);
    const contents = url.pathname.startsWith(`${repo}/contents/`) ? decodeURIComponent(url.pathname.slice(`${repo}/contents/`.length)) : null;
    if (contents !== null && (init.method ?? "GET") === "GET") {
      // A folder listing: the folders and files directly in it.
      const entries = new Map();
      for (const p of github.files.keys()) {
        if (!p.startsWith(contents + "/")) continue;
        const [first, ...rest] = p.slice(contents.length + 1).split("/");
        entries.set(first, rest.length ? {name: first, type: "dir", sha: `tree:${contents}/${first}`} : {name: first, type: "file", sha: await sha1(github.files.get(p))});
      }
      return entries.size ? json([...entries.values()]) : json({message: "Not Found"}, 404);
    }
    if (url.pathname.startsWith(`${repo}/git/trees/`)) {
      // A folder's tree by its fake SHA, or the whole repo's by the branch name.
      const ref = decodeURIComponent(url.pathname.slice(`${repo}/git/trees/`.length));
      const folder = ref === "main" ? "" : ref.slice("tree:".length);
      const tree = [];
      for (const [p, text] of github.files) {
        if (!folder || p.startsWith(folder + "/")) tree.push({path: folder ? p.slice(folder.length + 1) : p, type: "blob", mode: "100644", sha: await sha1(text), size: text.length});
      }
      // A symlink and a submodule that end in .md: never editable.
      tree.push({path: "link.md", type: "blob", mode: "120000", sha: "1".repeat(40), size: 10});
      tree.push({path: "vendored.md", type: "commit", mode: "160000", sha: "2".repeat(40)});
      return json({tree, truncated: false});
    }
    if (url.pathname.startsWith(`${repo}/git/blobs/`)) {
      const sha = url.pathname.split("/").pop();
      for (const text of github.files.values()) {
        if ((await sha1(text)) === sha) return json({content: btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/.{60}/g, "$&\n"), encoding: "base64"});
      }
      return json({message: "Not Found"}, 404);
    }
    if (contents !== null && init.method === "PUT") {
      const current = github.files.get(contents);
      if (current === undefined || (await sha1(current)) !== body.sha) return json({message: "does not match"}, 409);
      github.files.set(contents, new TextDecoder().decode(Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0))));
      return json({commit: {sha: "c0ffee" + "0".repeat(34)}});
    }
    return json({message: "Not Found"}, 404);
  };
  await putSite(env, {"index.html": "<h1>home</h1>", "ug/index.html": "<html><body>uganda</body></html>", "ug/coverage.html": "<html><body>coverage</body></html>"});
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(resetRepo);

let admin, plain, adminCsrf;
beforeAll(async () => {
  admin = await signUp("admin@example.org");
  await verify("admin@example.org");
  plain = await signUp("editor-plain@team.example");
  await verify("editor-plain@team.example");
  const token = decodeURIComponent(admin.split("=")[1]).split(".")[0];
  adminCsrf = await csrfToken(env.BETTER_AUTH_SECRET, token);
});

const page = (path, cookie) => call(path, {headers: {...NAV, cookie}});
const save = (path, fields, {cookie = admin, origin = "http://example.com"} = {}) => call(path, {method: "POST",
  headers: {"content-type": "application/x-www-form-urlencoded", origin, cookie}, body: new URLSearchParams(fields).toString()});
const shaOf = async (html) => html.match(/name="sha" value="([0-9a-f]{40})"/)[1];

describe("the editor", () => {
  it("is for admins only, and not there without a repo", async () => {
    for (const cookie of ["", plain]) {
      expect((await page("/_obs/edit/", cookie)).status).toBe(404);
      expect((await page("/_obs/edit/ug/coverage", cookie)).status).toBe(404);
      expect((await save("/_obs/edit/ug/coverage", {text: "x", sha: "a".repeat(40), csrf: adminCsrf}, {cookie})).status).toBe(404);
    }
    const noRepo = createApp(CONFIG);
    expect((await noRepo.fetch(new Request("http://example.com/_obs/edit/", {headers: {...NAV, cookie: admin}}), ENV)).status).toBe(404);
    expect(github.files.get(`${FOLDER}/coverage.md`)).toBe("# Coverage\n");
  });
  it("lists the site's Markdown files, not symlinks, submodules or other files", async () => {
    const res = await page("/_obs/edit/", admin);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/_obs/edit/ug/coverage"');
    expect(html).toContain('href="/_obs/edit/ug/index"');
    expect(html).toContain('href="/_obs/edit/ug/districts/kampala"');
    expect(html).not.toMatch(/link\.md|vendored\.md|notes\.csv/);
    expect(html).toContain("recodelabs/icr (main)");
  });
  it("opens a page's Markdown beside the live page", async () => {
    const html = await (await page("/_obs/edit/ug/districts/kampala", admin)).text();
    expect(html).toContain("<textarea");
    expect(html).toContain("\n# Kampala\n</textarea>");
    expect(html).toContain('<iframe src="/ug/districts/kampala"');
    expect(html).toContain(`name="sha" value="${await sha1("# Kampala\n")}"`);
    expect(html).toContain(`name="csrf" value="${adminCsrf}"`);
    expect(await (await page("/_obs/edit/ug/index", admin)).text()).toContain('<iframe src="/ug/"');
  });
  it("refuses anything not on the list, however it's spelled", async () => {
    for (const p of ["link", "vendored", "data/notes", "nope", "..%2Fsrc%2Fcoverage", "districts%2Fkampala", "%2E%2E/coverage", "coverage.md", "%zz"]) {
      const res = await page(`/_obs/edit/ug/${p}`, admin);
      expect(res.status, p).toBe(404);
    }
    expect((await page("/_obs/edit/main/index", admin)).status).toBe(404); // main has no folder in the repo
  });
  it("saves a page as one commit by the admin, with LF line endings", async () => {
    const sha = await shaOf(await (await page("/_obs/edit/ug/coverage", admin)).text());
    const res = await save("/_obs/edit/ug/coverage", {text: "# Coverage\r\n\r\nNew line.\r\n", sha, note: "add a line\nplease", csrf: adminCsrf});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/_obs/edit/ug/coverage?ok=saved&commit=c0ffee${"0".repeat(34)}`);
    expect(github.files.get(`${FOLDER}/coverage.md`)).toBe("# Coverage\n\nNew line.\n");
    const put = github.requests.find((r) => r.method === "PUT");
    expect(put.path).toBe(`/repos/recodelabs/icr/contents/${FOLDER}/coverage.md`);
    expect(put.body).toMatchObject({message: "Edit ug/coverage.md: add a line please", branch: "main", sha,
      author: {name: "admin@example.org", email: "admin@example.org"}});
    const after = await (await page(res.headers.get("location"), admin)).text();
    expect(after).toContain("Saved as commit c0ffee0 on main. The live page changes at the next deploy.");
  });
  it("doesn't commit when nothing changed", async () => {
    const sha = await shaOf(await (await page("/_obs/edit/ug/coverage", admin)).text());
    const res = await save("/_obs/edit/ug/coverage", {text: "# Coverage\r\n", sha, csrf: adminCsrf});
    expect(res.headers.get("location")).toBe("/_obs/edit/ug/coverage?ok=unchanged");
    expect(github.requests.some((r) => r.method === "PUT")).toBe(false);
  });
  it("keeps the draft and the note when a save fails, and still warns before leaving", async () => {
    const sha = await shaOf(await (await page("/_obs/edit/ug/coverage", admin)).text());
    github.down = true;
    const res = await save("/_obs/edit/ug/coverage", {text: "# Draft <b>\r\n", sha, note: "my note", csrf: adminCsrf});
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("Your edit wasn&#39;t saved.");
    expect(html).toContain("\n# Draft &lt;b&gt;\n</textarea>");
    expect(html).toContain('value="my note"');
    expect(html).toContain(`name="sha" value="${sha}"`);
    expect(html).toMatch(/id="editor" data-dirty>/);
    expect(await (await page("/_obs/edit/ug/coverage", admin)).text()).not.toContain("data-dirty");
  });
  it("keeps the draft when the file was deleted after it was opened", async () => {
    const sha = await shaOf(await (await page("/_obs/edit/ug/coverage", admin)).text());
    github.files.delete(`${FOLDER}/coverage.md`);
    const res = await save("/_obs/edit/ug/coverage", {text: "# Still mine\n", sha, note: "n", csrf: adminCsrf});
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("\n# Still mine\n</textarea>");
    expect(html).toMatch(/id="editor" data-dirty>/);
    expect(github.requests.some((r) => r.method === "PUT")).toBe(false);
  });
  it("lists and saves Markdown at the top of the repo", async () => {
    const top = createApp({...EDIT_CONFIG, repo: {...EDIT_CONFIG.repo, root: ""},
      sites: CONFIG.sites.map((s) => s.name === "ug" ? {...s, dir: "", root: ""} : s)});
    const get = async (path) => (await top.fetch(new Request("http://example.com" + path, {headers: {...NAV, cookie: admin}}), ENV)).text();
    expect(await get("/_obs/edit/")).toContain(`href="/_obs/edit/ug/${FOLDER.split("/").map(encodeURIComponent).join("/")}/coverage"`);
    const sha = await shaOf(await get(`/_obs/edit/ug/${FOLDER}/coverage`));
    const res = await top.fetch(new Request(`http://example.com/_obs/edit/ug/${FOLDER}/coverage`, {method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded", origin: "http://example.com", cookie: admin},
      body: new URLSearchParams({text: "# Top\n", sha, csrf: adminCsrf}).toString()}), ENV);
    expect(res.status).toBe(302);
    expect(github.requests.find((r) => r.method === "PUT").path).toBe(`/repos/recodelabs/icr/contents/${FOLDER}/coverage.md`);
  });
  it("refuses a save from another origin or without the session's token", async () => {
    const sha = await sha1("# Coverage\n");
    expect((await save("/_obs/edit/ug/coverage", {text: "x", sha, csrf: adminCsrf}, {origin: "https://evil.example"})).status).toBe(403);
    expect((await save("/_obs/edit/ug/coverage", {text: "x", sha, csrf: "0".repeat(32)})).status).toBe(403);
    expect((await save("/_obs/edit/ug/coverage", {text: "x", sha: "not-a-sha", csrf: adminCsrf})).status).toBe(400);
    expect(github.files.get(`${FOLDER}/coverage.md`)).toBe("# Coverage\n");
  });
  it("won't overwrite a change made on GitHub since the file was opened", async () => {
    const sha = await shaOf(await (await page("/_obs/edit/ug/coverage", admin)).text());
    github.files.set(`${FOLDER}/coverage.md`, "# Coverage\n\nSomeone else's edit.\n");
    const res = await save("/_obs/edit/ug/coverage", {text: "# Mine\n", sha, csrf: adminCsrf});
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("Someone changed this file on GitHub since you opened it");
    expect(html).toContain("\n# Mine\n</textarea>");
    expect(html).toContain(`name="sha" value="${sha}"`);
    expect(html).toMatch(/id="editor" data-dirty>/);
    expect(github.files.get(`${FOLDER}/coverage.md`)).toBe("# Coverage\n\nSomeone else's edit.\n");
  });
  it("says what's wrong when GitHub fails or the key is missing, without showing a token", async () => {
    github.down = true;
    let res = await page("/_obs/edit/ug/coverage", admin);
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("GitHub isn&#39;t responding");
    expect(html).not.toContain("ghs_");
    github.down = false;
    const noKey = createApp(EDIT_CONFIG);
    res = await noKey.fetch(new Request("http://example.com/_obs/edit/ug/coverage", {headers: {...NAV, cookie: admin}}), {...ENV, GITHUB_APP_PRIVATE_KEY: undefined});
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("GITHUB_APP_PRIVATE_KEY is missing");
  });
  it("takes the PKCS#1 key GitHub hands out as well as PKCS#8", async () => {
    // A 2048-bit key's PKCS#8 wrapper is 26 bytes ahead of the PKCS#1 key it carries.
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    expect(pkcs8[22]).toBe(0x04);
    const res = await app.fetch(new Request("http://example.com/_obs/edit/ug/coverage", {headers: {...NAV, cookie: admin}}),
      {...ENV, GITHUB_APP_PRIVATE_KEY: pem("RSA PRIVATE KEY", pkcs8.subarray(26))});
    expect(res.status).toBe(200);
  });
});

describe("the Edit this page link", () => {
  it("is on the pages an admin sees in a site with a folder, and nowhere else", async () => {
    expect(await (await page("/ug/coverage", admin)).text()).toContain('<a href="/_obs/edit/ug/coverage">Edit this page</a>');
    expect(await (await page("/ug/coverage", plain)).text()).not.toContain("Edit this page");
    expect(await (await page("/", admin)).text()).not.toContain("Edit this page");
  });
  it("names the page's Markdown file the way Framework builds it", () => {
    const config = loadConfig(EDIT_CONFIG);
    const ug = config.sites.find((s) => s.name === "ug");
    expect(editLink(config, ug, "ug/")).toBe("/_obs/edit/ug/index");
    expect(editLink(config, ug, "ug/coverage")).toBe("/_obs/edit/ug/coverage");
    expect(editLink(config, ug, "ug/coverage.html")).toBe("/_obs/edit/ug/coverage");
    expect(editLink(config, ug, "ug/districts/")).toBe("/_obs/edit/ug/districts/index");
    expect(editLink(config, ug, "ug/_file/data.parquet")).toBeNull();
    expect(editLink(config, config.sites.find((s) => s.name === "main"), "")).toBeNull();
  });
});
