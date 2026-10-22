// Who may see what (docs/spec.md, "Rules by who the user is").
//
// A request path (no leading slash) belongs to the site with the longest matching path, and
// gets a rule: the first matching exception in `access`, or else its site's `access`. Framework's
// client runtime (_observablehq/… except the search index, and _npm/…) is public within a site
// that has any public page, so those pages work for anonymous visitors; it holds no project code
// or data. A site's own modules (_import/…), data (_file/…) and search index follow the site's
// rule. (Until `observatory check` writes a manifest of each file's pages, exceptions can only
// make a page public (config.js), and cover only the paths they match, so a page opened by an
// exception can't load data its site keeps closed. That fails closed.)
//
// The order of checks, the same for every path:
//   1. a path whose rule is "disabled" is refused to everyone, admins too (404);
//   2. a public path is served, without looking at the session;
//   3. no session → sign in; a disabled user → refused; a user who isn't active → the pending page;
//   4. an admin is allowed;
//   5. anyone else is checked against the rule.

/** Glob → RegExp. `*` matches within a segment, `**` across segments. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (".+?^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

/**
 * One name for every URL that serves the same page, so a rule can't be missed through an
 * alias: `ug/plan`, `ug/plan/`, `ug/plan.html`, `ug/plan/index`, `ug/plan/index.html` all
 * become `ug/plan`, and `index.html`, `index` and `` become ``.
 */
export function pageKey(path) {
  let key = path;
  if (key.endsWith(".html")) key = key.slice(0, -".html".length);
  if (key === "index") return "";
  if (key.endsWith("/index")) key = key.slice(0, -"/index".length);
  if (key.endsWith("/")) key = key.slice(0, -1);
  return key;
}

const RUNTIME = /^(?:_observablehq\/|_npm\/)/;
// Framework writes the search index as _observablehq/minisearch.<hash>.json.
const SEARCH_INDEX = /^_observablehq\/minisearch(?:\.[0-9a-z]+)?\.json$/i;

export function compileAccess(config) {
  // Longest path first, so /ug/ wins over / for ug/….
  const sites = [...config.sites].sort((a, b) => b.prefix.length - a.prefix.length);
  const exceptions = config.exceptions.map((e) => ({...e, re: globToRegExp(e.match)}));
  const sitePublic = new Map(config.sites.map((s) => [s, s.access === "public"
    || config.exceptions.some((e) => e.allow === "public" && siteOf(e.match.replace(/\*.*$/, "")) === s)]));

  function siteOf(path) {
    return sites.find((s) => path.startsWith(s.prefix) || path === s.prefix.slice(0, -1)) ?? null;
  }

  /** The site and rule for a request path: {site, rule}; site is null for a path no site owns. */
  return function resolve(path) {
    const site = siteOf(path);
    if (!site) return {site: null, rule: "disabled"};
    const key = pageKey(path);
    for (const e of exceptions) if (e.re.test(path) || e.re.test(key)) return {site, rule: e.allow};
    const inSite = path.slice(site.prefix.length);
    if (sitePublic.get(site) && RUNTIME.test(inSite) && !SEARCH_INDEX.test(inSite)) return {site, rule: "public"};
    return {site, rule: site.access};
  };
}

const domainOf = (email) => String(email ?? "").toLowerCase().split("@")[1] ?? "";

/**
 * Whether one condition holds for a user. `who` is {user, claims, admin}: claims maps a
 * provider id to {groups, roles} from that provider's account (Keycloak; empty until sign-in
 * with it exists). Email conditions count only a verified address.
 */
export function holds(cond, who) {
  const {user, claims = new Map(), admin = false} = who;
  if ("email" in cond) return Boolean(user?.emailVerified) && String(user.email).toLowerCase() === cond.email;
  if ("emailDomain" in cond) return Boolean(user?.emailVerified) && domainOf(user.email) === cond.emailDomain;
  if ("group" in cond) return claims.get(cond.oidc)?.groups?.includes(cond.group) ?? false;
  if ("role" in cond && "oidc" in cond) return claims.get(cond.oidc)?.roles?.includes(cond.role) ?? false;
  if (cond.role === "admin") return admin;
  return false;
}

/**
 * A user's status, after the config: "disabled" (stored, wins over everything), "active", or
 * "pending". A verified address in `auth.email.allowedDomains`, or one that an `auth.admins`
 * email condition names, is active without approval; that is how the first admin gets in.
 */
export function statusOf(config, user, claims = new Map()) {
  if (!user) return null;
  if (user.status === "disabled") return "disabled";
  if (user.status === "active") return "active";
  if (user.emailVerified && config.auth.allowedDomains.includes(domainOf(user.email))) return "active";
  if (config.auth.admins.some((c) => ("email" in c || "emailDomain" in c) && holds(c, {user, claims}))) return "active";
  return user.status ?? "pending";
}

/** Whether an active user is an admin: made one on the admin page (D1), or by `auth.admins`. */
export function isAdmin(config, user, claims = new Map()) {
  if (statusOf(config, user, claims) !== "active") return false;
  return user.role === "admin" || config.auth.admins.some((c) => holds(c, {user, claims}));
}

/** Whether a rule lets a signed-in, active user in (admins are checked before this). */
export function allows(rule, who) {
  if (rule === "public" || rule === "signed-in") return true;
  if (rule === "disabled") return false;
  return rule.some((c) => holds(c, who));
}

/** How a rule reads to someone it keeps out, for the 403 page. */
export function describeRule(rule) {
  if (!Array.isArray(rule)) return [];
  return rule.map((c) => "email" in c ? `the account ${c.email}`
    : "emailDomain" in c ? `an account with a verified @${c.emailDomain} address`
    : "group" in c ? `members of the group ${c.group} (sign in with ${c.oidc})`
    : "oidc" in c ? `users with the role ${c.role} (sign in with ${c.oidc})`
    : "admins");
}

/**
 * The decision for one request: {kind: "serve", visibility} | {kind: "notfound"} |
 * {kind: "login"} | {kind: "pending"} | {kind: "refused", reason}. `user` is null without a
 * session; `claims` as for holds().
 */
export function decide(config, rule, user, claims = new Map()) {
  if (rule === "disabled") return {kind: "notfound"};
  if (rule === "public") return {kind: "serve", visibility: "public"};
  if (!user) return {kind: "login"};
  const status = statusOf(config, user, claims);
  if (status === "disabled") return {kind: "refused", reason: "disabled"};
  if (status !== "active") return {kind: "pending"};
  const admin = isAdmin(config, user, claims);
  if (admin || allows(rule, {user, claims, admin})) return {kind: "serve", visibility: "private"};
  return {kind: "refused", reason: "rule"};
}
