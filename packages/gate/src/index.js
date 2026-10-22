import {Hono} from "hono";
import {loadConfig} from "./config.js";
import {compileAccess, decide, describeRule} from "./access.js";
import {serveFromR2, notFound} from "./serve.js";
import {createAuth} from "./auth.js";
import {readSession, SessionUnavailable} from "./session.js";
import {obsPages} from "./pages/index.js";
import {page, html, escape} from "./pages/layout.js";

/** Local hostnames `wrangler dev` answers on; never redirected to the canonical host. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

const isNavigation = (request) => (request.headers.get("accept") || "").includes("text/html");
const noStore = (status, headers = {}) => new Response(null, {status, headers: {"cache-control": "no-store", ...headers}});

/**
 * Builds the Hono app for one deployment from its observatory.config.js. The config is checked
 * and the access rules compiled once, for the life of the isolate.
 */
export function createApp(rawConfig) {
  const config = loadConfig(rawConfig);
  const resolve = compileAccess(config);
  let cachedAuth = null;
  let cachedAuthDb = null;
  function authFor(env) {
    if (cachedAuth && cachedAuthDb === env.DB) return cachedAuth;
    cachedAuthDb = env.DB;
    return cachedAuth = createAuth(env, config);
  }

  const app = new Hono();

  // Canonical host: the gate can hold several routes (e.g. an old `monitor.*` hostname), but
  // cookies and trusted origins only work on BASE_URL's host, so everything else is sent
  // there first, path and query intact.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const canonical = new URL(c.env.BASE_URL).hostname;
    if (url.hostname !== canonical && !LOCAL_HOSTS.has(url.hostname)) {
      const to = new URL(url.pathname + url.search, c.env.BASE_URL);
      return new Response(null, {status: 301, headers: {location: to.toString()}});
    }
    await next();
  });

  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("auth", authFor(c.env));
    await next();
  });

  // Better Auth's admin plugin endpoints check only the stored role, not the gate's idea of an
  // admin (disabled users, auth.admins), so they are closed; the admin page does that work.
  app.all("/auth/admin/*", (c) => c.text("Not found", 404));
  app.all("/auth/*", (c) => c.get("auth").handler(c.req.raw));

  // doorman's pages moved from /_door/ to /_obs/; old links (in sign-in emails, bookmarks) follow.
  app.all("/_door/*", (c) => {
    const url = new URL(c.req.url);
    return new Response(null, {status: 301, headers: {location: "/_obs/" + url.pathname.slice("/_door/".length) + url.search}});
  });

  app.use("/_obs/*", async (c, next) => {
    try {
      c.set("session", await readSession(c.get("auth"), c.req.raw));
    } catch (err) {
      if (err instanceof SessionUnavailable) return c.text("Service unavailable", 503);
      throw err;
    }
    await next();
  });
  app.route("/_obs", obsPages);

  app.all("*", async (c) => {
    const request = c.req.raw;
    if (request.method !== "GET" && request.method !== "HEAD") return c.text("Method not allowed", 405);
    let path;
    try {
      path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
    } catch {
      return c.text("Bad request", 400); // malformed percent-escape in the path
    }
    if (path.split("/").includes("..")) return c.text("Bad request", 400);
    const {site, rule} = resolve(path);
    const notFoundKey = site ? `${site.prefix}404.html` : null;

    let user = null;
    if (rule !== "disabled" && rule !== "public") {
      try {
        user = (await readSession(c.get("auth"), request))?.user ?? null;
      } catch (err) {
        if (err instanceof SessionUnavailable) return c.text("Service unavailable", 503);
        throw err;
      }
    }
    // Keycloak claims arrive with sign-in through Keycloak (the next step); none yet.
    const d = decide(config, rule, user);
    const nav = isNavigation(request);
    switch (d.kind) {
      case "notfound":
        return notFound(c.env.SITE, notFoundKey ? config.sitesFolder + notFoundKey : null, request);
      case "login":
        return nav ? noStore(302, {location: `/_obs/login?next=${encodeURIComponent("/" + path)}`}) : noStore(401);
      case "pending":
        return nav ? noStore(302, {location: "/_obs/pending"}) : noStore(403);
      case "refused": {
        if (!nav) return noStore(403);
        const body = d.reason === "disabled"
          ? "<p>Your account has been disabled. Contact an administrator if you think this is a mistake.</p>"
          : `<p>You're signed in as <strong>${escape(user.email)}</strong>, but these dashboards are open only to:</p>
<ul>${describeRule(rule).map((w) => `<li>${escape(w)}</li>`).join("")}<li>admins</li></ul>
<p>Ask an administrator for access, or sign in with another account.</p>`;
        return html(c, page({config, title: "No access", body: body + `<form method="post" action="/_obs/signout"><button type="submit" class="quiet">Sign out</button></form>`}), 403);
      }
      default:
        return serveFromR2(c.env.SITE, config.sitesFolder, request, path, d.visibility, notFoundKey);
    }
  });

  return app;
}

/** The Worker export for a deployment: `export default createGate(config)` in its entry file. */
export function createGate(rawConfig) {
  const app = createApp(rawConfig);
  return {fetch: app.fetch};
}
