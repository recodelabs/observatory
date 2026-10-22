import {Hono} from "hono";
import {callAuth, authErrorMessage} from "../auth.js";
import {page, html, escape, safeNext, withCookies} from "./layout.js";
import {statusOf} from "../access.js";

const RATE_LIMITED = "Too many attempts, try again in a minute.";
const MISCONFIGURED = "Sign-in is misconfigured for this hostname, contact the administrator.";

export const login = new Hono();

/** The OIDC providers that can be used here: configured, with their client secret set. */
const providersOf = (config, env) => config.auth.oidc.filter((p) => env[p.secretName]);

function loginForm({config, env, next, email = "", message, error}) {
  const providers = providersOf(config, env);
  const oidc = providers.map((p) => `
<form method="post" action="/_obs/oidc/${escape(p.id)}">
  <input type="hidden" name="next" value="${escape(next)}">
  <button type="submit">Sign in with ${escape(p.name)}</button>
</form>`).join("") + (providers.length ? `<p class="muted" style="text-align:center">or with your email</p>` : "");
  const body = `${oidc}
<form method="post" action="/_obs/login">
  <input type="hidden" name="next" value="${escape(next)}">
  <label for="email">Email</label><input id="email" type="email" name="email" value="${escape(email)}" required autofocus>
  <label for="password">Password</label><input id="password" type="password" name="password" required>
  <button type="submit">Sign in</button>
</form>
<form method="post" action="/_obs/magic" style="margin-top:12px">
  <input type="hidden" name="next" value="${escape(next)}"><input type="hidden" name="email" value="${escape(email)}">
  <button type="submit" class="quiet" onclick="this.form.email.value=document.getElementById('email').value">Email me a sign-in link instead</button>
</form>
<p class="muted">No account? <a href="/_obs/signup">Sign up</a></p>`;
  return page({config, title: "Sign in", body, message, error});
}

login.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  const s = c.get("session");
  if (s?.user && statusOf(c.get("config"), s.user, s.provider) === "active") return c.redirect(next, 302);
  if (s?.user) return c.redirect("/_obs/pending", 302);
  const error = c.req.query("error") ? "Sign-in didn't work. Try again, or ask an administrator." : null;
  return html(c, loginForm({config: c.get("config"), env: c.env, next, error}));
});

login.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  const config = c.get("config");
  const res = await callAuth(c.get("auth"), c.env, c.req.raw, "/auth/sign-in/email", {email, password: String(form.password || "")});
  if (res.status === 200) return withCookies(c.redirect(next, 302), res.headers);
  let error;
  if (res.status === 429) error = RATE_LIMITED;
  else if (res.status === 403) error = MISCONFIGURED;
  else if (res.status === 400 || res.status === 401) error = "Invalid email or password.";
  else error = (await authErrorMessage(res)) || "Sign-in failed, try again.";
  return html(c, loginForm({config, env: c.env, next, email, error}));
});

// Start sign-in with an OIDC provider: Better Auth answers with the provider's authorization
// URL and sets its state cookie; the browser goes there, and comes back to /auth/callback/<id>.
login.post("/oidc/:id", async (c) => {
  const config = c.get("config");
  const provider = providersOf(config, c.env).find((p) => p.id === c.req.param("id"));
  if (!provider) return c.text("Not found", 404);
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const res = await callAuth(c.get("auth"), c.env, c.req.raw, "/auth/sign-in/social",
    {provider: provider.id, callbackURL: next, errorCallbackURL: `/_obs/login?error=oidc&next=${encodeURIComponent(next)}`});
  let url = null;
  try { url = res.status === 200 ? (await res.json())?.url : null; } catch { /* not JSON */ }
  if (!url || !String(url).startsWith(provider.issuer + "/")) {
    return html(c, loginForm({config, env: c.env, next, error: res.status === 429 ? RATE_LIMITED : `Sign-in with ${provider.name} isn't working right now. Try again later.`}));
  }
  return withCookies(c.redirect(url, 302), res.headers);
});

login.post("/magic", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  const config = c.get("config");
  if (!email) return html(c, loginForm({config, env: c.env, next, error: "Enter your email first."}));
  const auth = c.get("auth");
  // Only ask Better Auth to send when the address actually has an account: the magic-link
  // endpoint mails whatever it is given, which would turn this form into an open relay for
  // one fixed message. The answer below is the same either way, so nothing is enumerable.
  const known = await auth.db.selectFrom("user").select("id").where("email", "=", email).executeTakeFirst();
  if (known) await callAuth(auth, c.env, c.req.raw, "/auth/sign-in/magic-link", {email, callbackURL: next});
  return html(c, page({config, title: "Check your email", body: `<p>If <strong>${escape(email)}</strong> has an account, a sign-in link is on its way. It expires in 5 minutes.</p><p><a href="/_obs/login">Back</a></p>`}));
});
