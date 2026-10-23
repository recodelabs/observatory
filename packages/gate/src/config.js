// The gate's view of observatory.config.js: the sites and their access, the exceptions, the
// admins, sign-in settings and branding. Everything is checked once, when the Worker starts, so
// a bad config fails the deploy rather than a request.

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const PATH = /^\/(?:[A-Za-z0-9_.-]+\/)*$/;
const LEVELS = new Set(["public", "signed-in", "disabled"]);

/** Check one access condition; returns it normalized. `where` names it in errors. */
function condition(c, where, {allowRole = true} = {}) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${where}: a condition must be an object`);
  const keys = Object.keys(c).sort().join(",");
  if (keys === "email" && typeof c.email === "string" && c.email.includes("@")) return {email: c.email.toLowerCase()};
  if (keys === "emailDomain" && typeof c.emailDomain === "string" && /^[a-z0-9.-]+$/i.test(c.emailDomain)) return {emailDomain: c.emailDomain.toLowerCase()};
  if (keys === "group,oidc" && typeof c.group === "string" && c.group.startsWith("/")) return {oidc: String(c.oidc), group: c.group};
  if (keys === "oidc,role" && typeof c.role === "string" && c.role) return {oidc: String(c.oidc), role: c.role};
  if (allowRole && keys === "role" && c.role === "admin") return {role: "admin"};
  throw new Error(`${where}: unknown condition ${JSON.stringify(c)} (use {email}, {emailDomain}, {oidc, group}, {oidc, role}${allowRole ? " or {role: \"admin\"}" : ""})`);
}

/** Check an access value: "public", "signed-in", "disabled" or a list of conditions. */
function access(a, where) {
  if (a === undefined) return "signed-in";
  if (typeof a === "string") {
    if (!LEVELS.has(a)) throw new Error(`${where}: "public", "signed-in", "disabled" or a list of conditions (got ${JSON.stringify(a)})`);
    return a;
  }
  if (!Array.isArray(a) || !a.length) throw new Error(`${where}: a non-empty list of conditions`);
  return a.map((c, i) => condition(c, `${where}[${i}]`));
}

/** A folder in the repo: a relative path without "." or ".." segments; "" for the top. */
function folder(f, where) {
  if (typeof f !== "string" || f.startsWith("/") || f.endsWith("/") || /\\/.test(f)
      || (f !== "" && f.split("/").some((x) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(x)))) {
    throw new Error(`${where}: a folder in the repo, like "sites/main" (no leading or trailing "/")`);
  }
  return f;
}

/** The repo the editor commits to, or null when there is none (no editor). */
function repo(r) {
  if (r === undefined || r === null) return null;
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(r.github ?? "");
  if (!m || m[2] === "." || m[2] === "..") throw new Error(`repo.github: "owner/name", like "recodelabs/icr"`);
  if (typeof r.branch !== "string" || !/^[A-Za-z0-9_./-]+$/.test(r.branch) || r.branch.split("/").includes("..")) throw new Error("repo.branch: a branch name");
  // The GitHub App that commits the edits: its App ID or Client ID. Its private key is the
  // Worker secret GITHUB_APP_PRIVATE_KEY, never in the config.
  const app = r.app === undefined ? null : String(r.app);
  if (app !== null && !/^(?:\d+|Iv[A-Za-z0-9.]+)$/.test(app)) throw new Error("repo.app: the GitHub App's App ID or Client ID");
  return {owner: m[1], name: m[2], branch: r.branch, root: folder(r.root ?? "", "repo.root"), app};
}

export function loadConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("observatory.config.js must export a config object");
  const sites = (raw.sites ?? []).map((s, i) => {
    const where = `sites[${i}]`;
    if (!NAME.test(s?.name ?? "")) throw new Error(`${where}.name: lowercase letters, digits and -`);
    if (!PATH.test(s.path ?? "") || s.path.split("/").includes("..")) throw new Error(`${where}.path: starts and ends with "/"`);
    // Request paths have no leading slash: the site at "/ug/" owns "ug/…", the site at "/" owns "".
    // Where the site's Markdown lives in the repo, for the editor: repo.root + dir + root.
    const dir = s.dir === undefined ? null : folder(s.dir, `${where}.dir`);
    const root = folder(s.root ?? "src", `${where}.root`);
    return {name: s.name, path: s.path, prefix: s.path.slice(1), access: access(s.access, `${where}.access`), dir, root};
  });
  if (!sites.length) throw new Error("sites: at least one site is required");
  const paths = new Set();
  for (const s of sites) {
    if (paths.has(s.path)) throw new Error(`sites: path ${s.path} is used twice`);
    paths.add(s.path);
  }
  // Exceptions can only open a page to the public (v1). A stricter exception would close the
  // page but not its data, modules or search text, which follow the site; that needs the
  // manifest of each file's pages from `observatory check`, which doesn't exist yet. A public
  // exception fails closed instead: the page opens, and data its site keeps closed stays closed.
  const exceptions = (raw.access ?? []).map((e, i) => {
    if (typeof e?.match !== "string" || !e.match || e.match.startsWith("/")) throw new Error(`access[${i}].match: a path glob without a leading "/"`);
    if (e.allow !== "public") throw new Error(`access[${i}].allow: only "public" for now; to close part of a site, make it a site of its own`);
    return {match: e.match, allow: "public"};
  });
  const auth = raw.auth ?? {};
  // Keycloak realms (or any OpenID Connect provider). Each one's client secret is the Worker
  // secret OIDC_<ID>_SECRET (upper case, - as _), never in the config.
  const oidc = (auth.oidc ?? []).map((p, i) => {
    const where = `auth.oidc[${i}]`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p?.id ?? "") || p.id === "email") throw new Error(`${where}.id: lowercase letters, digits and - (not "email")`);
    let issuer;
    try { issuer = new URL(p.issuer); } catch { throw new Error(`${where}.issuer: the realm's URL, e.g. https://auth.example.org/realms/uga`); }
    if (issuer.protocol !== "https:" && issuer.hostname !== "localhost") throw new Error(`${where}.issuer: https`);
    return {id: p.id, name: p.name ?? p.id, issuer: issuer.href.replace(/\/$/, ""), clientId: p.clientId ?? "observatory",
      secretName: `OIDC_${p.id.toUpperCase().replaceAll("-", "_")}_SECRET`};
  });
  const ids = new Set();
  for (const p of oidc) {
    if (ids.has(p.id)) throw new Error(`auth.oidc: id ${p.id} is used twice`);
    ids.add(p.id);
  }
  // An admin condition can't be "an admin": that would be circular.
  const admins = (auth.admins ?? []).map((c, i) => condition(c, `auth.admins[${i}]`, {allowRole: false}));
  const sitesFolder = raw.cloudflare?.sites ?? "_site/";
  if (!/^(?:[A-Za-z0-9_.-]+\/)+$/.test(sitesFolder) || sitesFolder.split("/").includes("..")) throw new Error(`cloudflare.sites: a bucket folder ending in "/"`);
  // Every {oidc: …} condition must name a configured provider.
  const named = [...sites.flatMap((s) => Array.isArray(s.access) ? s.access : []), ...admins].filter((c) => "oidc" in c);
  for (const c of named) if (!ids.has(c.oidc)) throw new Error(`condition ${JSON.stringify(c)}: no provider "${c.oidc}" in auth.oidc`);
  return {
    sites,
    exceptions,
    sitesFolder,
    repo: repo(raw.repo),
    brand: {title: raw.brand?.title ?? "Dashboards", accent: raw.brand?.accent ?? null, logo: raw.brand?.logo ?? null},
    auth: {
      sessionDays: auth.sessionDays ?? 30,
      allowedDomains: (auth.email?.allowedDomains ?? []).map((d) => d.toLowerCase()),
      admins,
      oidc,
      oidcSessionHours: auth.oidcSessionHours ?? 12,
      claimsMaxAge: auth.claimsMaxAge ?? 900
    },
    mail: {from: auth.email?.from ?? "observatory@localhost", adminNotify: auth.email?.adminNotify ?? null}
  };
}
