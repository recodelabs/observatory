import {Hono} from "hono";
import {page, html, withCookies} from "./layout.js";
import {statusOf} from "../access.js";

export const pending = new Hono();

pending.get("/pending", (c) => {
  const s = c.get("session");
  const config = c.get("config");
  if (!s?.user) return c.redirect("/_obs/login", 302);
  const status = statusOf(config, s.user, s.provider);
  if (status === "active") return c.redirect("/", 302);
  const text = status === "disabled"
    ? "Your account has been disabled. Contact an administrator if you think this is a mistake."
    : !s.user.emailVerified
      ? "Check your email for a link to confirm your address. If your address is one this site accepts, that's all; otherwise an administrator approves the account, and you'll get an email when they do."
      : "Your account is waiting for approval. You will get an email when it is approved.";
  const body = `<p>${text}</p><form method="post" action="/_obs/signout"><button type="submit" class="quiet">Sign out</button></form>`;
  return html(c, page({config, title: "Almost there", body}));
});

pending.post("/signout", async (c) => {
  try {
    const {headers} = await c.get("auth").api.signOut({headers: c.req.raw.headers, returnHeaders: true});
    return withCookies(c.redirect("/_obs/login", 302), headers);
  } catch {
    // Signing out with no active session throws; still redirect.
    return c.redirect("/_obs/login", 302);
  }
});
