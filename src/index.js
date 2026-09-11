import {Hono} from "hono";
import {loadConfig} from "./config.js";
import {compileRules} from "./rules.js";
import {decide, isNavigation} from "./gate.js";
import {serveFromR2} from "./serve.js";
import {createAuth} from "./auth.js";
import {readSession, SessionUnavailable} from "./session.js";
import {doorPages} from "./pages/index.js";

const baseConfig = loadConfig();
const baseRules = compileRules(baseConfig.pages);

// Rule compilation, and Better Auth's setup, are per-deployment work — doing either per
// request costs on every hit. Bindings are stable for the life of an isolate, so both are
// built once and reused; the test-only TEST_PAGES variant gets its own cached pair.
let testConfig = null;
let testRules = null;
let cachedAuth = null;
let cachedAuthDb = null;

function configFor(env) {
  // Tests inject page rules; production uses doorman.config.js as-is.
  if (!env.TEST_PAGES) return baseConfig;
  return testConfig ??= {...baseConfig, pages: JSON.parse(env.TEST_PAGES)};
}

function rulesFor(env, config) {
  if (!env.TEST_PAGES) return baseRules;
  return testRules ??= compileRules(config.pages);
}

function authFor(env, config) {
  if (cachedAuth && cachedAuthDb === env.DB) return cachedAuth;
  cachedAuthDb = env.DB;
  return cachedAuth = createAuth(env, config);
}

/** Local hostnames `wrangler dev` answers on; never redirected to the canonical host. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export const app = new Hono();

// Canonical host: doorman can hold several routes (e.g. an old `monitor.*` hostname), but
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
  const config = configFor(c.env);
  c.set("config", config);
  c.set("auth", authFor(c.env, config));
  c.set("resolveAccess", rulesFor(c.env, config));
  await next();
});

app.all("/auth/*", (c) => c.get("auth").handler(c.req.raw));

app.use("/_door/*", async (c, next) => {
  try {
    c.set("session", await readSession(c.get("auth"), c.req.raw));
  } catch (err) {
    if (err instanceof SessionUnavailable) return c.text("Service unavailable", 503);
    throw err;
  }
  await next();
});
app.route("/_door", doorPages);

app.all("*", async (c) => {
  const request = c.req.raw;
  if (request.method !== "GET" && request.method !== "HEAD") return c.text("Method not allowed", 405);
  let path;
  try {
    path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
  } catch {
    return c.text("Bad request", 400); // malformed percent-escape in the path
  }
  const access = c.get("resolveAccess")(path);
  let user = null;
  if (access === "protected") {
    try {
      user = (await readSession(c.get("auth"), request))?.user ?? null;
    } catch (err) {
      if (err instanceof SessionUnavailable) return c.text("Service unavailable", 503);
      throw err;
    }
  }
  const d = decide({access, user, isNavigation: isNavigation(request), path});
  const config = c.get("config");
  switch (d.kind) {
    case "redirect": return new Response(null, {status: 302, headers: {location: d.to, "cache-control": "no-store"}});
    case "status": return new Response(null, {status: d.status, headers: {"cache-control": "no-store"}});
    case "notfound": {
      const nf = await c.env.SITE.get(`_site/${config.site.name}/404.html`);
      const body = request.method === "HEAD" ? null : nf ? nf.body : "Not found";
      return new Response(body, {status: 404, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
    }
    default: return serveFromR2(c.env.SITE, `_site/${config.site.name}/`, request, path, access);
  }
});

export default {fetch: app.fetch};
