import {env, exports} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, setStatus, get, NAV} from "./helpers.js";

beforeAll(() => putSite(env, {
  "index.html": "<h1>home</h1>", "about.html": "<h1>about</h1>", "ntd.html": "<h1>ntd</h1>", "404.html": "nope",
  "_file/data/x.abc.parquet": new Uint8Array(10), "_observablehq/client.js": "js"
}));
// doorman.config.js in the repo has pages: [] — the tests below inject rules through
// the TEST_PAGES binding, which src/index.js honours only when defined (see Step 4).

describe("routing", () => {
  it("anonymous navigation to a protected page redirects to login with next", async () => {
    const res = await get("/coverage", NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_door/login?next=%2Fcoverage");
  });
  it("anonymous data fetch gets 401, not a redirect", async () => {
    const res = await get("/_file/data/x.abc.parquet");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
  it("public page and runtime chunk serve anonymously; data stays protected", async () => {
    expect((await get("/about", NAV)).status).toBe(200);
    expect((await get("/_observablehq/client.js")).status).toBe(200);
    expect((await get("/_file/data/x.abc.parquet")).status).toBe(401);
  });
  // Storage (D1 + R2) is shared across tests in this file, so signups in earlier tests
  // affect later ones: "first@example.org" below becomes the first user (admin, active),
  // which is why the next test's "p@example.org" signup is pending, not admin.
  it("disabled page is 404 even for an active user", async () => {
    const cookie = await signUp("first@example.org"); // first user → admin, active
    expect((await get("/ntd", {...NAV, cookie})).status).toBe(404);
    expect((await get("/ntd", NAV)).status).toBe(404);
  });
  it("pending user is sent to /_door/pending; approved user gets the page and the data", async () => {
    const cookie = await signUp("p@example.org");
    let res = await get("/", {...NAV, cookie});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_door/pending");
    expect((await get("/_file/data/x.abc.parquet", {cookie})).status).toBe(403);
    await setStatus("p@example.org", "active");
    res = await get("/", {...NAV, cookie});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    res = await get("/_file/data/x.abc.parquet", {cookie, range: "bytes=0-3"});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/10");
  });
  it("/auth/* is reachable without a session", async () => {
    const res = await get("/auth/get-session");
    expect(res.status).toBe(200);
  });
  it("non-GET to site paths is 405", async () => {
    const res = await exports.default.fetch("http://example.com/about", {method: "POST"});
    expect(res.status).toBe(405);
  });
});
