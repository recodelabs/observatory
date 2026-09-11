import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, get, post, NAV} from "./helpers.js";

const idOf = async (email) => (await env.DB.prepare("select id from user where email = ?").bind(email).first()).id;
const statusOf = async (email) => (await env.DB.prepare("select status, role from user where email = ?").bind(email).first());
async function tokenFor(cookie) {
  const html = await (await get("/_door/admin", {...NAV, cookie})).text();
  return html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
}

let adminCookie, userCookie;
beforeAll(async () => {
  await putSite(env, {"index.html": "home"});
  // Shared D1 storage within this file: the first sign-up becomes admin (see auth.js
  // databaseHooks), so admin@example.org must sign up before any other account.
  adminCookie = await signUp("admin@example.org");
  userCookie = await signUp("user@example.org");
});

describe("admin page", () => {
  it("is 404 for anonymous and for non-admins", async () => {
    expect((await get("/_door/admin", NAV)).status).toBe(404);
    expect((await get("/_door/admin", {...NAV, cookie: userCookie})).status).toBe(404);
  });
  it("lists users with status and a csrf token for admins", async () => {
    const res = await get("/_door/admin", {...NAV, cookie: adminCookie});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user@example.org");
    expect(html).toMatch(/name="csrf" value="[a-f0-9]{32}"/);
    expect(html).toContain('action="/_door/admin/approve"');
  });
  it("approve flips status and rejects a bad csrf", async () => {
    const userId = await idOf("user@example.org");
    let res = await post("/_door/admin/approve", {userId, csrf: "deadbeef"}, {cookie: adminCookie});
    expect(res.status).toBe(403);
    expect((await statusOf("user@example.org")).status).toBe("pending");
    res = await post("/_door/admin/approve", {userId, csrf: await tokenFor(adminCookie)}, {cookie: adminCookie});
    expect(res.status).toBe(302);
    expect((await statusOf("user@example.org")).status).toBe("active");
  });
  it("disable, enable, make-admin, remove-admin, delete", async () => {
    const userId = await idOf("user@example.org");
    const csrf = await tokenFor(adminCookie);
    await post("/_door/admin/disable", {userId, csrf}, {cookie: adminCookie});
    expect((await statusOf("user@example.org")).status).toBe("disabled");
    await post("/_door/admin/enable", {userId, csrf}, {cookie: adminCookie});
    expect((await statusOf("user@example.org")).status).toBe("active");
    await post("/_door/admin/make-admin", {userId, csrf}, {cookie: adminCookie});
    expect((await statusOf("user@example.org")).role).toBe("admin");
    await post("/_door/admin/remove-admin", {userId, csrf}, {cookie: adminCookie});
    expect((await statusOf("user@example.org")).role).toBe("user");
    await post("/_door/admin/delete", {userId, csrf}, {cookie: adminCookie});
    expect(await statusOf("user@example.org")).toBeNull();
  });
  it("an admin cannot disable, demote, or delete themself", async () => {
    const me = await idOf("admin@example.org");
    const csrf = await tokenFor(adminCookie);
    for (const action of ["disable", "remove-admin", "delete"]) {
      const res = await post("/_door/admin/" + action, {userId: me, csrf}, {cookie: adminCookie});
      expect(res.status).toBe(400);
    }
    expect((await statusOf("admin@example.org")).status).toBe("active");
  });
  it("non-admin POSTs are 404", async () => {
    const res = await post("/_door/admin/approve", {userId: "x", csrf: "y"}, {cookie: userCookie});
    expect(res.status).toBe(404);
  });
});
