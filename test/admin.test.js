import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, get, post, NAV} from "./helpers.js";

const idOf = async (email) => (await env.DB.prepare("select id from user where email = ?").bind(email).first()).id;
const statusOf = async (email) => (await env.DB.prepare("select status, role from user where email = ?").bind(email).first());

// Matches the csrf field of a specific per-row action form, never a bare `name="csrf"`
// floating anywhere on the page — a token only counts if it's actually inside a
// submittable form.
const csrfFieldIn = (html, action) => html.match(
  new RegExp(`<form method="post" action="/_door/admin/${action}">[\\s\\S]*?name="csrf" value="([a-f0-9]{32})"`)
);

let adminCookie, userCookie, csrf;
beforeAll(async () => {
  await putSite(env, {"index.html": "home"});
  // Shared D1 storage within this file: the first sign-up becomes admin (see auth.js
  // databaseHooks), so admin@example.org must sign up before any other account.
  adminCookie = await signUp("admin@example.org");
  userCookie = await signUp("user@example.org");
  // Capture the csrf token once, while user@example.org's row is still non-self and
  // pending, so its "approve" form actually carries one. The token itself is just an
  // HMAC of the admin's own session token (see csrf.js) — independent of which user or
  // action it's attached to — so this one value stays valid for every admin action for
  // the rest of the file, including the later self-protection case where the admin is
  // the only row left and legitimately has no action form (and so no token) on the page.
  const html = await (await get("/_door/admin", {...NAV, cookie: adminCookie})).text();
  csrf = csrfFieldIn(html, "approve")[1];
});

describe("admin page", () => {
  it("is 404 for anonymous and for non-admins", async () => {
    expect((await get("/_door/admin", NAV)).status).toBe(404);
    expect((await get("/_door/admin", {...NAV, cookie: userCookie})).status).toBe(404);
  });
  it("lists users with status and a csrf token inside the approve form", async () => {
    const res = await get("/_door/admin", {...NAV, cookie: adminCookie});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user@example.org");
    expect(csrfFieldIn(html, "approve")).not.toBeNull();
  });
  it("approve flips status and rejects a bad csrf", async () => {
    const userId = await idOf("user@example.org");
    let res = await post("/_door/admin/approve", {userId, csrf: "deadbeef"}, {cookie: adminCookie});
    expect(res.status).toBe(403);
    expect((await statusOf("user@example.org")).status).toBe("pending");
    res = await post("/_door/admin/approve", {userId, csrf}, {cookie: adminCookie});
    expect(res.status).toBe(302);
    expect((await statusOf("user@example.org")).status).toBe("active");
  });
  it("disable, enable, make-admin, remove-admin, delete", async () => {
    const userId = await idOf("user@example.org");
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
  it("rejects an action name that collides with an inherited Object property", async () => {
    const res = await post("/_door/admin/constructor", {userId: "x", csrf}, {cookie: adminCookie});
    expect(res.status).toBe(404);
  });
});
