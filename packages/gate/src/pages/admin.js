import {Hono} from "hono";
import {page, html, escape} from "./layout.js";
import {csrfToken, checkCsrf} from "./csrf.js";
import {dbFor, listUsers, setStatus, setRole, deleteUser, getUser} from "../users.js";
import {isAdmin, statusOf, holds} from "../access.js";
import {sendMail, MailError} from "../mail.js";

export const admin = new Hono();

// Hono only finalizes the response from a middleware's *return value*; a block-bodied
// wrapper that calls requireAdmin without returning it discards the 404 Response and
// leaves the context unfinalized, so these forward the promise instead.
admin.use("/admin/*", (c, next) => requireAdmin(c, next));
admin.use("/admin", (c, next) => requireAdmin(c, next));
// Checked on every request, from the user as stored now: the admin page and its actions are
// for admins only (made one here, or named by auth.admins), and anyone else gets a plain 404.
async function requireAdmin(c, next) {
  const s = c.get("session");
  if (!s?.user || !isAdmin(c.get("config"), s.user)) return c.text("Not found", 404);
  await next();
}

const fmt = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";

admin.get("/admin", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  const csrf = await csrfToken(c.env.BETTER_AUTH_SECRET, s.session.token);
  const users = await listUsers(dbFor(c.env));
  const btn = (action, userId, label) => `<form method="post" action="/_obs/admin/${action}"><input type="hidden" name="userId" value="${escape(userId)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${label}</button></form>`;
  const byConfig = (u) => config.auth.admins.some((cond) => holds(cond, {user: u}));
  const rows = users.map((u) => {
    const self = u.id === s.user.id;
    const status = statusOf(config, u);
    const role = byConfig(u) ? "admin (config)" : u.role;
    const actions = [
      status !== "active" ? btn(status === "pending" ? "approve" : "enable", u.id, status === "pending" ? "Approve" : "Enable") : (!self ? btn("disable", u.id, "Disable") : ""),
      byConfig(u) ? "" : u.role === "admin" ? (!self ? btn("remove-admin", u.id, "Remove admin") : "") : btn("make-admin", u.id, "Make admin"),
      !self ? btn("delete", u.id, "Delete") : ""
    ].join("");
    return `<tr><td>${escape(u.email)}<br><span class="muted">${escape(u.name)}${u.emailVerified ? "" : " · email not confirmed"}</span></td><td>${escape(status)}</td><td>${escape(role)}</td><td>${fmt(u.createdAt)}</td><td>${fmt(u.lastSignIn)}</td><td>${actions}</td></tr>`;
  }).join("");
  const body = `<table><thead><tr><th>User</th><th>Status</th><th>Role</th><th>Created</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Signed in as ${escape(s.user.email)} · <a href="/">Site</a></p><form method="post" action="/_obs/signout"><button class="quiet">Sign out</button></form>`;
  return html(c, page({config, title: "Users", body, wide: true, message: c.req.query("ok") ? "Done." : null}));
});

const ACTIONS = {
  approve: {status: "active", notify: true}, enable: {status: "active"}, disable: {status: "disabled", notSelf: true},
  "make-admin": {role: "admin"}, "remove-admin": {role: "user", notSelf: true}, delete: {remove: true, notSelf: true}
};

admin.post("/admin/:action", async (c) => {
  const action = c.req.param("action");
  // ACTIONS[action] would also resolve inherited Object.prototype properties (e.g.
  // "constructor", "toString") to a truthy, spec-shaped-enough value; require an own key.
  if (!Object.hasOwn(ACTIONS, action)) return c.text("Not found", 404);
  const spec = ACTIONS[action];
  const s = c.get("session");
  const form = await c.req.parseBody();
  if (!(await checkCsrf(c.env.BETTER_AUTH_SECRET, s.session.token, form.csrf))) return c.text("Bad token", 403);
  const userId = String(form.userId || "");
  if (spec.notSelf && userId === s.user.id) return c.text("You cannot do that to your own account", 400);
  const db = dbFor(c.env);
  const target = await getUser(db, userId);
  if (!target) return c.text("No such user", 404);
  // Written to D1 directly: an admin named by auth.admins has no admin role stored, which
  // Better Auth's own admin endpoints would require.
  if (spec.remove) await deleteUser(db, userId);
  if (spec.role) await setRole(db, userId, spec.role);
  if (spec.status) await setStatus(db, userId, spec.status);
  if (spec.notify && target.status !== "active") {
    const config = c.get("config");
    try {
      await sendMail(c.env, config, {to: target.email, subject: `${config.brand.title}: your account is approved`, text: `You can sign in now:\n\n${c.env.BASE_URL}/`});
    } catch (err) {
      if (!(err instanceof MailError)) throw err;
    }
  }
  return c.redirect("/_obs/admin?ok=1", 302);
});
