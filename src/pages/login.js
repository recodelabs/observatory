import {Hono} from "hono";
import {APIError} from "better-auth/api";
import {page, html, escape, safeNext, withCookies} from "./layout.js";

export const login = new Hono();

function loginForm({config, next, email = "", message, error}) {
  const body = `
<form method="post" action="/_door/login">
  <input type="hidden" name="next" value="${escape(next)}">
  <label for="email">Email</label><input id="email" type="email" name="email" value="${escape(email)}" required autofocus>
  <label for="password">Password</label><input id="password" type="password" name="password" required>
  <button type="submit">Sign in</button>
</form>
<form method="post" action="/_door/magic" style="margin-top:12px">
  <input type="hidden" name="next" value="${escape(next)}"><input type="hidden" name="email" value="${escape(email)}">
  <button type="submit" class="quiet" onclick="this.form.email.value=document.getElementById('email').value">Email me a sign-in link instead</button>
</form>
<p class="muted">No account? <a href="/_door/signup">Sign up</a></p>`;
  return page({config, title: "Sign in", body, message, error});
}

login.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  const s = c.get("session");
  if (s?.user?.status === "active") return c.redirect(next, 302);
  if (s?.user) return c.redirect("/_door/pending", 302);
  return html(c, loginForm({config: c.get("config"), next}));
});

login.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  try {
    const {headers} = await c.get("auth").api.signInEmail({
      body: {email, password: String(form.password || "")}, headers: c.req.raw.headers, returnHeaders: true
    });
    return withCookies(c.redirect(next, 302), headers);
  } catch (err) {
    if (err instanceof APIError) return html(c, loginForm({config: c.get("config"), next, email, error: "Invalid email or password."}));
    throw err;
  }
});

login.post("/magic", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  const config = c.get("config");
  if (!email) return html(c, loginForm({config, next, error: "Enter your email first."}));
  try {
    await c.get("auth").api.signInMagicLink({body: {email, callbackURL: next}, headers: c.req.raw.headers});
  } catch (err) {
    if (!(err instanceof APIError)) throw err; // unknown email etc. → same message, no enumeration
  }
  return html(c, page({config, title: "Check your email", body: `<p>If <strong>${escape(email)}</strong> has an account, a sign-in link is on its way. It expires in 5 minutes.</p><p><a href="/_door/login">Back</a></p>`}));
});
