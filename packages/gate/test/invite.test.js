import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect, vi} from "vitest";
import {inviteExisting} from "../src/users.js";
import {app, putSite, signUp, signIn, verify, get, post, NAV} from "./helpers.js";

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
  it("inviting an unconfirmed signup first takes away its sessions and password", async () => {
    // Anyone can sign up with someone else's address; until it is confirmed, the password and
    // sessions may be a stranger's. The invitation must reach only the mailbox's owner.
    const squatter = await signUp("waiting@elsewhere.test");
    const before = await row("waiting@elsewhere.test");
    expect(before.status).toBe("pending");
    await post("/_obs/admin/invite", form({email: "waiting@elsewhere.test", site: "ug", admin: "1"}), {cookie: adminCookie});
    expect((await row("waiting@elsewhere.test")).status).toBe("active");
    expect(await grants("waiting@elsewhere.test")).toEqual(["ug"]);
    const old = await get("/ug/", {...NAV, cookie: squatter});
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toMatch(/^\/_obs\/login/);
    await expect(signIn("waiting@elsewhere.test")).rejects.toThrow(/sign-in 40/);
    // The invited account is a new one. A password sign-in that read the old credentials before
    // the invitation would write its session for the old id, which no longer exists.
    expect((await row("waiting@elsewhere.test")).id).not.toBe(before.id);
    const now = new Date().toISOString();
    await expect(env.DB.prepare(`insert into session (id, expiresAt, token, createdAt, updatedAt, userId) values (?, ?, ?, ?, ?, ?)`)
      .bind("late", now, "late-token", now, now, before.id).run()).rejects.toThrow(/FOREIGN KEY/i);
    // The owner signs in with the emailed link, which confirms the address.
    const owner = await signInByLink("waiting@elsewhere.test");
    expect((await get("/ug/", {...NAV, cookie: owner})).status).toBe(200);
    expect((await get("/_obs/admin", {...NAV, cookie: owner})).status).toBe(200);
  });
  it("inviting a confirmed user keeps their sign-in and adds the sites", async () => {
    const cookie = await signUp("known@elsewhere.test");
    await verify("known@elsewhere.test");
    await post("/_obs/admin/invite", form({email: "known@elsewhere.test", site: "ug"}), {cookie: adminCookie});
    expect((await row("known@elsewhere.test")).status).toBe("active");
    expect((await get("/ug/", {...NAV, cookie})).status).toBe(200);
  });
  it("doesn't re-enable a disabled account, confirmed or not", async () => {
    for (const [email, confirmed] of [["off1@elsewhere.test", false], ["off2@elsewhere.test", true]]) {
      await signUp(email);
      if (confirmed) await verify(email);
      await env.DB.prepare("update user set status = 'disabled' where email = ?").bind(email).run();
      const {id} = await row(email);
      const res = await post("/_obs/admin/invite", form({email, site: "ug", admin: "1"}), {cookie: adminCookie});
      expect(res.headers.get("location")).toBe("/_obs/admin?ok=disabled");
      const after = await row(email);
      expect(after).toMatchObject({id, status: "disabled", role: "user"});
      expect(await grants(email)).toEqual([]);
    }
  });
  it("an account disabled between the check and the invitation's writes stays as it is", async () => {
    await signUp("racer@elsewhere.test");
    await verify("racer@elsewhere.test");
    const {id} = await row("racer@elsewhere.test");
    // The admin page found it pending; it is disabled before the invitation's batch runs.
    await env.DB.prepare("update user set status = 'disabled' where id = ?").bind(id).run();
    await inviteExisting(env.DB, id, {makeAdmin: true, sites: ["ug"], by: "admin@example.org"});
    expect(await row("racer@elsewhere.test")).toMatchObject({status: "disabled", role: "user"});
    expect(await grants("racer@elsewhere.test")).toEqual([]);
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
