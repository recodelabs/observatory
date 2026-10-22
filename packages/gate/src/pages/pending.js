import {Hono} from "hono";
import {page, html, withCookies} from "./layout.js";

export const pending = new Hono();

pending.get("/pending", (c) => {
  const s = c.get("session");
  const config = c.get("config");
  if (!s?.user) return c.redirect("/_door/login", 302);
  if (s.user.status === "active") return c.redirect("/", 302);
  const text = s.user.status === "disabled"
    ? "Your account has been disabled. Contact the administrator if you think this is a mistake."
    : "Your account is waiting for approval. You will get an email when it is approved.";
  const body = `<p>${text}</p><form method="post" action="/_door/signout"><button type="submit" class="quiet">Sign out</button></form>`;
  return html(c, page({config, title: "Almost there", body}));
});

pending.post("/signout", async (c) => {
  try {
    const {headers} = await c.get("auth").api.signOut({headers: c.req.raw.headers, returnHeaders: true});
    return withCookies(c.redirect("/_door/login", 302), headers);
  } catch {
    // Signing out with no active session throws; still redirect.
    return c.redirect("/_door/login", 302);
  }
});
