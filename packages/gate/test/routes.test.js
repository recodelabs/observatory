import {env, exports} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {app, putSite, signUp, signIn, setStatus, verify, get, NAV} from "./helpers.js";

beforeAll(() => putSite(env, {
  "index.html": "<h1>home</h1>", "about.html": "<h1>about</h1>", "ntd.html": "<h1>ntd</h1>", "404.html": "nope",
  "_file/data/x.abc.parquet": new Uint8Array(10), "_observablehq/client.js": "js",
  "_observablehq/minisearch.json": "{}",
  "ug/index.html": "<h1>uganda</h1>", "ug/404.html": "ug nope", "ug/_file/data/t.parquet": new Uint8Array(4)
}));
// The config under test is CONFIG in helpers.js: main site signed-in, `about` public, `ntd`
// disabled, /ug/ open to verified team.example addresses; admin@example.org an admin by config.

describe("routing", () => {
  it("anonymous navigation to a protected page redirects to login with next", async () => {
    const res = await get("/coverage", NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_obs/login?next=%2Fcoverage");
    expect(res.headers.get("cache-control")).toBe("no-store"); // never let an edge cache a gate decision
  });
  it("a request on another hostname is 301'd to BASE_URL's host, path and query intact", async () => {
    const res = await app.fetch(new Request("http://monitor.example.com/coverage?x=1", {headers: NAV}), env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://example.com/coverage?x=1");
  });
  it("old /_door/ links go to /_obs/", async () => {
    const res = await get("/_door/login?next=%2Fug%2F");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/_obs/login?next=%2Fug%2F");
  });
  it("a malformed percent-escape in the path is 400, not 500", async () => {
    const res = await app.fetch(new Request("http://example.com/%E0%A4%A"), env);
    expect(res.status).toBe(400);
  });
  it("anonymous data fetch gets 401, not a redirect", async () => {
    const res = await get("/_file/data/x.abc.parquet");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
  it("a public page and the runtime serve anonymously; data and the search index stay closed", async () => {
    expect((await get("/about", NAV)).status).toBe(200);
    expect((await get("/_observablehq/client.js")).status).toBe(200);
    expect((await get("/_observablehq/minisearch.json")).status).toBe(401);
    expect((await get("/_file/data/x.abc.parquet")).status).toBe(401);
  });
  it("a disabled page is 404 for everyone, admins too, with the site's 404 page", async () => {
    const cookie = await signUp("admin@example.org");
    await verify("admin@example.org");
    const res = await get("/ntd", {...NAV, cookie});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("nope");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const head = await app.fetch(new Request("http://example.com/ntd", {method: "HEAD", headers: NAV}), env);
    expect(head.status).toBe(404);
    expect(await head.text()).toBe(""); // HEAD carries no body, not even the 404 page
  });
  it("a pending user is sent to /_obs/pending; once approved, gets the page and the data", async () => {
    const cookie = await signUp("p@example.org");
    let res = await get("/", {...NAV, cookie});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_obs/pending");
    expect((await get("/_file/data/x.abc.parquet", {cookie})).status).toBe(403);
    await setStatus("p@example.org", "active");
    res = await get("/", {...NAV, cookie});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    res = await get("/_file/data/x.abc.parquet", {cookie, range: "bytes=0-3"});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/10");
  });
  it("a verified address in an allowed domain needs no approval", async () => {
    const cookie = await signUp("member@allowed.example");
    expect((await get("/", {...NAV, cookie})).status).toBe(302); // not confirmed yet
    await verify("member@allowed.example");
    expect((await get("/", {...NAV, cookie})).status).toBe(200);
  });
  it("a nested site applies its own rule: the domain gets in, others get a 403 page that says who can", async () => {
    const team = await signUp("t@team.example");
    await setStatus("t@team.example", "active");
    expect((await get("/ug/", {...NAV, cookie: team})).status).toBe(403); // address not confirmed
    await verify("t@team.example");
    const page = await get("/ug/", {...NAV, cookie: team});
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>uganda</h1>");
    expect((await get("/ug/_file/data/t.parquet", {cookie: team})).status).toBe(200);

    const other = await signUp("o@example.org");
    await setStatus("o@example.org", "active");
    const refused = await get("/ug/", {...NAV, cookie: other});
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/verified @team\.example address/);
    expect((await get("/ug/_file/data/t.parquet", {cookie: other})).status).toBe(403);
    expect((await get("/", {...NAV, cookie: other})).status).toBe(200); // the main site is for any signed-in user
  });
  it("an admin by config sees every site", async () => {
    const admin = await signIn("admin@example.org");
    expect((await get("/ug/", {...NAV, cookie: admin})).status).toBe(200);
    expect((await get("/ug/_file/data/t.parquet", {cookie: admin})).status).toBe(200);
  });
  it("a disabled user is refused a protected page", async () => {
    const cookie = await signUp("gone@team.example");
    await verify("gone@team.example");
    await setStatus("gone@team.example", "disabled");
    const res = await get("/ug/", {...NAV, cookie});
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/disabled/);
  });
  it("a nested site without a trailing slash is redirected to it", async () => {
    const admin = await signIn("admin@example.org");
    const res = await get("/ug", {...NAV, cookie: admin});
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/ug/");
  });
  it("/auth/* is reachable without a session", async () => {
    const res = await get("/auth/get-session");
    expect(res.status).toBe(200);
  });
  it("non-GET to site paths is 405", async () => {
    const res = await app.fetch(new Request("http://example.com/about", {method: "POST"}), env);
    expect(res.status).toBe(405);
  });
  // Last request in this file on purpose: exports.default.fetch is the entrypoint the
  // Worker actually ships, and a second D1-touching call through it hangs (see helpers.js).
  // It runs example/observatory.config.js, whose /team/ site is closed to anonymous visitors.
  it("the shipped entrypoint gates a protected path", async () => {
    const res = await exports.default.fetch("http://example.com/team/coverage", {headers: NAV, redirect: "manual"});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_obs/login?next=%2Fteam%2Fcoverage");
  });
});
