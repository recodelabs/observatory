import {Hono} from "hono";
import {loadConfig} from "./config.js";
import {compileRules} from "./rules.js";
import {decide, isNavigation} from "./gate.js";
import {serveFromR2} from "./serve.js";
import {createAuth} from "./auth.js";
import {readSession, SessionUnavailable} from "./session.js";
import {doorPages} from "./pages/index.js";

const baseConfig = loadConfig();

function configFor(env) {
  // Tests inject page rules; production uses doorman.config.js as-is.
  if (env.TEST_PAGES) return {...baseConfig, pages: JSON.parse(env.TEST_PAGES)};
  return baseConfig;
}

export const app = new Hono();

app.use("*", async (c, next) => {
  const config = configFor(c.env);
  c.set("config", config);
  c.set("auth", createAuth(c.env, config));
  c.set("resolveAccess", compileRules(config.pages));
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
  const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
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
    case "redirect": return c.redirect(d.to, 302);
    case "status": return new Response(null, {status: d.status, headers: {"cache-control": "no-store"}});
    case "notfound": {
      const nf = await c.env.SITE.get(`_site/${config.site.name}/404.html`);
      return new Response(nf ? nf.body : "Not found", {status: 404, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
    }
    default: return serveFromR2(c.env.SITE, `_site/${config.site.name}/`, request, path, access);
  }
});

export default {fetch: app.fetch};
