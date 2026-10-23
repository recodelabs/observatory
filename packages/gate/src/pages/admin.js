import {Hono} from "hono";
import {page, html, escape} from "./layout.js";
import {csrfToken, checkCsrf} from "./csrf.js";
import {dbFor, listUsers, setStatus, setRole, deleteUser, getUser, getUserByEmail, createInvitedUser, setSites, addSites, resetUnconfirmed} from "../users.js";
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
  if (!s?.user || !isAdmin(c.get("config"), s)) return c.text("Not found", 404);
  await next();
}

const fmt = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** The sites an admin can open to individual users: those whose access is a list of conditions. */
const grantable = (config) => config.sites.filter((s) => Array.isArray(s.access));
const siteLabel = (s) => `${s.name} (${s.path})`;

/** The ticked site names in a parsed form, keeping only sites that can be granted. */
function chosenSites(config, form) {
  const ticked = [form.site ?? []].flat().map(String);
  return grantable(config).map((s) => s.name).filter((n) => ticked.includes(n));
}

const MESSAGES = {done: "Done.", invited: "Invitation sent.", "invited-nomail": "The account is ready, but the invitation email could not be sent. Ask them to sign in with an email link from the sign-in page."};

admin.get("/admin", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  const csrf = await csrfToken(c.env.BETTER_AUTH_SECRET, s.session.token);
  const users = await listUsers(dbFor(c.env));
  const sites = grantable(config);
  const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
  const btn = (action, userId, label) => `<form method="post" action="/_obs/admin/${action}"><input type="hidden" name="userId" value="${escape(userId)}">${csrfField}<button type="submit">${label}</button></form>`;
  const byConfig = (u) => config.auth.admins.some((cond) => holds(cond, {user: u}));
  const rows = users.map((u) => {
    const self = u.id === s.user.id;
    const keycloak = u.providers.some((p) => config.auth.oidc.some((o) => o.id === p));
    const status = keycloak && u.status !== "disabled" ? "active" : statusOf(config, u);
    const role = byConfig(u) ? "admin (config)" : u.role;
    const actions = [
      status !== "active" ? btn(status === "pending" ? "approve" : "enable", u.id, status === "pending" ? "Approve" : "Enable") : (!self ? btn("disable", u.id, "Disable") : ""),
      byConfig(u) ? "" : u.role === "admin" ? (!self ? btn("remove-admin", u.id, "Remove admin") : "") : btn("make-admin", u.id, "Make admin"),
      !self ? btn("delete", u.id, "Delete") : ""
    ].join("");
    const how = [u.providers.join(", ") || "email link", u.groups.length ? u.groups.join(" ") : ""].filter(Boolean).join(" · ");
    const siteForm = sites.length ? `<td><form method="post" action="/_obs/admin/sites" class="sites"><input type="hidden" name="userId" value="${escape(u.id)}">${csrfField}`
      + sites.map((x) => `<label class="check"><input type="checkbox" name="site" value="${escape(x.name)}"${u.sites.includes(x.name) ? " checked" : ""}> ${escape(x.name)}</label>`).join("")
      + `<button type="submit">Save</button></form></td>` : "";
    return `<tr><td>${escape(u.email)}<br><span class="muted">${escape(u.name)}${u.emailVerified ? "" : " · email not confirmed"} · ${escape(how)}</span></td><td>${escape(status)}</td><td>${escape(role)}</td>${siteForm}<td>${fmt(u.createdAt)}</td><td>${fmt(u.lastSignIn)}</td><td>${actions}</td></tr>`;
  }).join("");
  const invite = `<h2>Invite someone</h2>
<form method="post" action="/_obs/admin/invite" class="invite">${csrfField}
  <div class="row"><div><label for="invite-email">Email</label><input id="invite-email" type="email" name="email" required></div>
  <div><label for="invite-name">Name <span class="muted">(optional)</span></label><input id="invite-name" type="text" name="name"></div></div>
  ${sites.length ? `<label>Can see</label><div class="checks">${sites.map((x) => `<label class="check"><input type="checkbox" name="site" value="${escape(x.name)}"> ${escape(siteLabel(x))}</label>`).join("")}</div>` : ""}
  <div><label class="check"><input type="checkbox" name="admin" value="1"> Admin <span class="muted">(every site, and this page)</span></label></div>
  <div><button type="submit">Send invitation</button></div>
</form>
<p class="muted">They get an email with a link to sign in; no password is needed.${sites.length ? " Public sites need no invitation." : ""}</p>`;
  const body = `${invite}<h2>Users</h2><table><thead><tr><th>User</th><th>Status</th><th>Role</th>${sites.length ? "<th>Can see</th>" : ""}<th>Created</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table>
${sites.length ? `<p class="muted">"Can see" lists the sites you have opened to each person. People also get in through the site's own rules (for example a Keycloak group or an email domain), and admins see every site.</p>` : ""}
<p class="muted">Signed in as ${escape(s.user.email)} · <a href="/">Site</a></p><form method="post" action="/_obs/signout"><button class="quiet">Sign out</button></form>`;
  const ok = c.req.query("ok");
  return html(c, page({config, title: "Settings", body, wide: true, message: ok ? (MESSAGES[ok] ?? MESSAGES.done) : null}));
});

// Invite: create the account (active, no password) or find the existing one (an unconfirmed one
// is reset first), open the ticked sites to it, and email a link to the sign-in page. The sign-in link itself is sent when they
// ask for it there: magic links last minutes, and an invitation may wait days.
admin.post("/admin/invite", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  const form = await c.req.parseBody({all: true});
  if (!(await checkCsrf(c.env.BETTER_AUTH_SECRET, s.session.token, form.csrf))) return c.text("Bad token", 403);
  const email = String(form.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) return c.text("Enter a valid email address", 400);
  const name = String(form.name || "").trim().slice(0, 200);
  const sites = chosenSites(config, form);
  const makeAdmin = form.admin === "1";
  const db = dbFor(c.env);
  let user = await getUserByEmail(db, email);
  if (!user) {
    await createInvitedUser(db, {email, name, role: makeAdmin ? "admin" : "user"});
    user = await getUserByEmail(db, email);
  } else {
    // Someone may have signed up with this address without owning it: an account whose address
    // isn't confirmed loses its sessions and credentials before it gets anything, so only the
    // person who reads the invitation's mailbox can sign into it.
    if (!user.emailVerified) await resetUnconfirmed(c.env.DB, user.id);
    if (user.status === "pending") await setStatus(db, user.id, "active");
    if (makeAdmin) await setRole(db, user.id, "admin");
  }
  await addSites(c.env.DB, user.id, sites, s.user.email);
  const where = makeAdmin ? "every site" : sites.length ? sites.map((n) => siteLabel(config.sites.find((x) => x.name === n))).join(", ") : config.brand.title;
  const link = `${c.env.BASE_URL}/_obs/login?email=${encodeURIComponent(email)}`;
  try {
    await sendMail(c.env, config, {to: email, subject: `You're invited to ${config.brand.title}`,
      text: `${s.user.email} has invited you to ${config.brand.title} (${where}).\n\nTo sign in, open\n\n${link}\n\nand choose "Email me a sign-in link". No password is needed.`});
  } catch (err) {
    if (!(err instanceof MailError)) throw err;
    return c.redirect("/_obs/admin?ok=invited-nomail", 302);
  }
  return c.redirect("/_obs/admin?ok=invited", 302);
});

// The sites an admin has opened to one user, replaced by the ticked ones.
admin.post("/admin/sites", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  const form = await c.req.parseBody({all: true});
  if (!(await checkCsrf(c.env.BETTER_AUTH_SECRET, s.session.token, form.csrf))) return c.text("Bad token", 403);
  const db = dbFor(c.env);
  const target = await getUser(db, String(form.userId || ""));
  if (!target) return c.text("No such user", 404);
  await setSites(c.env.DB, target.id, chosenSites(config, form), s.user.email);
  return c.redirect("/_obs/admin?ok=done", 302);
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
  return c.redirect("/_obs/admin?ok=done", 302);
});
