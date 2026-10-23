import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect, vi} from "vitest";
import {app, putSite, signUp, verify, get, post, NAV} from "./helpers.js";

// helpers.js's config: "main" (/, signed-in), "ug" (/ug/, the team.example domain) and "off"
// (/off/, disabled). Only "ug" has a list of conditions, so only "ug" can be granted.
const row = (email) => env.DB.prepare("select id, status, role, emailVerified from user where email = ?").bind(email).first();
const grants = async (email) => (await env.DB.prepare("select site from siteGrant where userId = (select id from user where email = ?) order by site")
  .bind(email).all()).results.map((r) => r.site);

/** Runs `fn` with console.log captured; returns [result, logged text]. */
async function capture(fn) {
  const lines = [];
  const log = vi.spyOn(console, "log").mockImplementation((line) => void lines.push(String(line)));
  try {
    return [await fn(), lines.join("\n")];
  } finally {
    log.mockRestore();
  }
}

/** Signs in through the emailed link, as an invited user would. Returns the session cookie. */
async function signInByLink(email) {
  const [, mailed] = await capture(() => post("/_obs/magic", {email, next: "/"}));
  const url = mailed.match(/http:\/\/example\.com\/auth\/magic-link\/verify\S+/)?.[0];
  expect(url).toBeTruthy();
  const res = await app.fetch(new Request(url, {headers: {"cf-connecting-ip": "10.9.9.9"}}), env);
  const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).find((c) => c?.startsWith("better-auth.session_token="));
  expect(cookie).toBeTruthy();
  return cookie.split(";")[0];
}

let adminCookie, csrf;
const form = (fields) => [...Object.entries(fields), ["csrf", csrf]];

beforeAll(async () => {
  await putSite(env, {"index.html": "<h1>home</h1>", "ug/index.html": "<h1>uganda</h1>"});
  adminCookie = await signUp("admin@example.org");
  await verify("admin@example.org");
  const html = await (await get("/_obs/admin", {...NAV, cookie: adminCookie})).text();
  csrf = html.match(/action="\/_obs\/admin\/invite"[^>]*>\s*<input type="hidden" name="csrf" value="([a-f0-9]{32})"/)[1];
});

describe("invitations", () => {
  it("the admin page has an invite form offering only the sites with conditions", async () => {
    const html = await (await get("/_obs/admin", {...NAV, cookie: adminCookie})).text();
    expect(html).toContain('action="/_obs/admin/invite"');
    expect(html).toContain('name="site" value="ug"');
    expect(html).not.toContain('name="site" value="main"');
    expect(html).not.toContain('name="site" value="off"');
  });
  it("refuses a bad csrf token and a bad address", async () => {
    expect((await post("/_obs/admin/invite", {email: "x@elsewhere.test", csrf: "nope"}, {cookie: adminCookie})).status).toBe(403);
    expect((await post("/_obs/admin/invite", form({email: "not an address"}), {cookie: adminCookie})).status).toBe(400);
    expect(await row("x@elsewhere.test")).toBeNull();
  });
  it("is for admins only", async () => {
    const other = await signUp("plain@example.org");
    expect((await post("/_obs/admin/invite", form({email: "y@elsewhere.test"}), {cookie: other})).status).toBe(404);
    expect(await row("y@elsewhere.test")).toBeNull();
  });
  it("creates an active account with the ticked sites and emails a link to the sign-in page", async () => {
    const [res, mailed] = await capture(() => post("/_obs/admin/invite",
      form({email: "Guest@Elsewhere.test", name: "Guest", site: "ug"}), {cookie: adminCookie}));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_obs/admin?ok=invited");
    const u = await row("guest@elsewhere.test");
    expect(u.status).toBe("active");
    expect(u.role).toBe("user");
    expect(await grants("guest@elsewhere.test")).toEqual(["ug"]);
    expect(mailed).toContain("to=guest@elsewhere.test");
    expect(mailed).toContain("http://example.com/_obs/login?email=guest%40elsewhere.test");
  });
  it("ignores sites that can't be granted", async () => {
    await post("/_obs/admin/invite", [["email", "picky@elsewhere.test"], ["site", "main"], ["site", "off"], ["site", "nope"], ["site", "ug"], ["csrf", csrf]], {cookie: adminCookie});
    expect(await grants("picky@elsewhere.test")).toEqual(["ug"]);
  });
  it("the invited user signs in by link, their address is confirmed, and they see their site", async () => {
    const login = await (await get("/_obs/login?email=guest%40elsewhere.test", NAV)).text();
    expect(login).toContain('value="guest@elsewhere.test"');
    const cookie = await signInByLink("guest@elsewhere.test");
    expect((await row("guest@elsewhere.test")).emailVerified).toBe(1);
    const ug = await get("/ug/", {...NAV, cookie});
    expect(ug.status).toBe(200);
    expect(await ug.text()).toContain("uganda");
    // main is open to any active user; off is disabled for everyone, grants or not.
    expect((await get("/", {...NAV, cookie})).status).toBe(200);
    expect((await get("/off/", {...NAV, cookie})).status).toBe(404);
  });
  it("taking a site away closes it at the next request", async () => {
    const cookie = await signInByLink("guest@elsewhere.test");
    const {id} = await row("guest@elsewhere.test");
    const res = await post("/_obs/admin/sites", form({userId: id}), {cookie: adminCookie});
    expect(res.status).toBe(302);
    expect(await grants("guest@elsewhere.test")).toEqual([]);
    const ug = await get("/ug/", {...NAV, cookie});
    expect(ug.status).toBe(403);
    expect(await ug.text()).toContain("people an admin has added to this site");
    await post("/_obs/admin/sites", form({userId: id, site: "ug"}), {cookie: adminCookie});
    expect((await get("/ug/", {...NAV, cookie})).status).toBe(200);
  });
  it("a grant doesn't let in a disabled user", async () => {
    const cookie = await signInByLink("guest@elsewhere.test");
    await env.DB.prepare("update user set status = 'disabled' where email = ?").bind("guest@elsewhere.test").run();
    expect((await get("/ug/", {...NAV, cookie})).status).toBe(403);
    await env.DB.prepare("update user set status = 'active' where email = ?").bind("guest@elsewhere.test").run();
  });
  it("inviting someone who signed up activates them and adds the sites", async () => {
    await signUp("waiting@elsewhere.test");
    expect((await row("waiting@elsewhere.test")).status).toBe("pending");
    await post("/_obs/admin/invite", form({email: "waiting@elsewhere.test", site: "ug"}), {cookie: adminCookie});
    expect((await row("waiting@elsewhere.test")).status).toBe("active");
    expect(await grants("waiting@elsewhere.test")).toEqual(["ug"]);
  });
  it("can invite an admin", async () => {
    await post("/_obs/admin/invite", form({email: "boss@elsewhere.test", admin: "1"}), {cookie: adminCookie});
    expect((await row("boss@elsewhere.test")).role).toBe("admin");
  });
  it("deleting a user removes their grants", async () => {
    const {id} = await row("picky@elsewhere.test");
    await post("/_obs/admin/delete", form({userId: id}), {cookie: adminCookie});
    expect((await env.DB.prepare("select count(*) as n from siteGrant where userId = ?").bind(id).first()).n).toBe(0);
  });
});
