import {Hono} from "hono";
import {callAuth, authErrorMessage} from "../auth.js";
import {page, html, escape, safeNext, withCookies} from "./layout.js";
import {statusOf} from "../access.js";

const RATE_LIMITED = "Too many attempts, try again in a minute.";
const MISCONFIGURED = "Sign-in is misconfigured for this hostname, contact the administrator.";

export const login = new Hono();

function loginForm({config, next, email = "", message, error}) {
  const body = `
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
  if (s?.user && statusOf(c.get("config"), s.user) === "active") return c.redirect(next, 302);
  if (s?.user) return c.redirect("/_obs/pending", 302);
  return html(c, loginForm({config: c.get("config"), next}));
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
  return html(c, loginForm({config, next, email, error}));
});

login.post("/magic", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  const config = c.get("config");
  if (!email) return html(c, loginForm({config, next, error: "Enter your email first."}));
  const auth = c.get("auth");
  // Only ask Better Auth to send when the address actually has an account: the magic-link
  // endpoint mails whatever it is given, which would turn this form into an open relay for
  // one fixed message. The answer below is the same either way, so nothing is enumerable.
  const known = await auth.db.selectFrom("user").select("id").where("email", "=", email).executeTakeFirst();
  if (known) await callAuth(auth, c.env, c.req.raw, "/auth/sign-in/magic-link", {email, callbackURL: next});
  return html(c, page({config, title: "Check your email", body: `<p>If <strong>${escape(email)}</strong> has an account, a sign-in link is on its way. It expires in 5 minutes.</p><p><a href="/_obs/login">Back</a></p>`}));
});
