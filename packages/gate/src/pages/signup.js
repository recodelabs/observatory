import {Hono} from "hono";
import {callAuth, authErrorMessage} from "../auth.js";
import {page, html, escape, withCookies} from "./layout.js";

export const signup = new Hono();

function signupForm({config, email = "", name = "", error}) {
  const body = `
<form method="post" action="/_door/signup">
  <label for="name">Name</label><input id="name" type="text" name="name" value="${escape(name)}" required>
  <label for="email">Email</label><input id="email" type="email" name="email" value="${escape(email)}" required>
  <label for="password">Password <span class="muted">(10+ characters)</span></label><input id="password" type="password" name="password" minlength="10" required>
  <button type="submit">Create account</button>
</form>
<p class="muted">New accounts need approval by an administrator before they can see anything.</p>
<p class="muted"><a href="/_door/login">Back to sign in</a></p>`;
  return page({config, title: "Sign up", body, error});
}

signup.get("/signup", (c) => html(c, signupForm({config: c.get("config")})));

signup.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email || "").trim().toLowerCase();
  const name = String(form.name || "").trim() || email;
  const config = c.get("config");
  const res = await callAuth(c.get("auth"), c.env, c.req.raw, "/auth/sign-up/email", {email, name, password: String(form.password || "")});
  if (res.status === 200) return withCookies(c.redirect("/_door/pending", 302), res.headers);
  let error;
  if (res.status === 429) error = "Too many attempts, try again in a minute.";
  else if (res.status === 403) error = "Sign-up is misconfigured for this hostname, contact the administrator.";
  else {
    const message = (await authErrorMessage(res)) || "Could not create the account, try again.";
    error = /exist/i.test(message) ? "An account with that email already exists. Try signing in." : message;
  }
  return html(c, signupForm({config, email, name, error}));
});
