import {Hono} from "hono";
import {page, html, escape} from "./layout.js";
import {csrfToken, checkCsrf} from "./csrf.js";
import {dbFor, listUsers, setStatus, getUser} from "../users.js";
import {sendMail} from "../mail.js";

export const admin = new Hono();

// Hono only finalizes the response from a middleware's *return value*; a block-bodied
// wrapper that calls requireAdmin without returning it discards the 404 Response and
// leaves the context unfinalized, so these forward the promise instead.
admin.use("/admin/*", (c, next) => requireAdmin(c, next));
admin.use("/admin", (c, next) => requireAdmin(c, next));
async function requireAdmin(c, next) {
  const s = c.get("session");
  if (!s?.user || s.user.role !== "admin" || s.user.status !== "active") return c.text("Not found", 404);
  await next();
}

const fmt = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";

admin.get("/admin", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  const csrf = await csrfToken(c.env.BETTER_AUTH_SECRET, s.session.token);
  const users = await listUsers(dbFor(c.env));
  const btn = (action, userId, label) => `<form method="post" action="/_door/admin/${action}"><input type="hidden" name="userId" value="${escape(userId)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${label}</button></form>`;
  const rows = users.map((u) => {
    const self = u.id === s.user.id;
    const actions = [
      u.status !== "active" ? btn(u.status === "pending" ? "approve" : "enable", u.id, u.status === "pending" ? "Approve" : "Enable") : (!self ? btn("disable", u.id, "Disable") : ""),
      u.role === "admin" ? (!self ? btn("remove-admin", u.id, "Remove admin") : "") : btn("make-admin", u.id, "Make admin"),
      !self ? btn("delete", u.id, "Delete") : ""
    ].join("");
    return `<tr><td>${escape(u.email)}<br><span class="muted">${escape(u.name)}</span></td><td>${escape(u.status)}</td><td>${escape(u.role)}</td><td>${fmt(u.createdAt)}</td><td>${fmt(u.lastSignIn)}</td><td>${actions}</td></tr>`;
  }).join("");
  const body = `<table><thead><tr><th>User</th><th>Status</th><th>Role</th><th>Created</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Signed in as ${escape(s.user.email)} · <a href="/">Site</a></p><form method="post" action="/_door/signout"><button class="quiet">Sign out</button></form>`;
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
  const auth = c.get("auth");
  if (spec.remove) await auth.api.removeUser({body: {userId}, headers: c.req.raw.headers});
  if (spec.role) await auth.api.setRole({body: {userId, role: spec.role}, headers: c.req.raw.headers});
  if (spec.status) await setStatus(db, userId, spec.status);
  if (spec.notify && target.status !== "active") {
    const config = c.get("config");
    await sendMail(c.env, config, {to: target.email, subject: `${config.brand.title}: your account is approved`, text: `You can sign in now:\n\n${c.env.BASE_URL}/`});
  }
  return c.redirect("/_door/admin?ok=1", 302);
});
