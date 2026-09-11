export const PREFIX = "_site/campaignhq/";
export async function putSite(env, files) {
  for (const [key, body] of Object.entries(files)) await env.SITE.put(PREFIX + key, body);
}

const PASSWORD = "correct horse battery";

async function post(auth, path, body, ip) {
  const res = await auth.handler(new Request(`http://example.com/auth${path}`, {
    method: "POST",
    headers: {"content-type": "application/json", origin: "http://example.com", "cf-connecting-ip": ip},
    body: JSON.stringify(body)
  }));
  if (res.status !== 200) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.headers.get("set-cookie");
}

/**
 * Creates an account through the real /auth endpoints. Returns the session cookie.
 * `ip` is the client address the rate limiter buckets on: pass a distinct one when a
 * test needs more sign-ups than the per-IP limit allows.
 */
export function signUp(auth, email, password = PASSWORD, ip = "127.0.0.1") {
  return post(auth, "/sign-up/email", {email, password, name: email}, ip);
}

/** Signs an existing account in. Returns the session cookie. */
export function signIn(auth, email, password = PASSWORD, ip = "127.0.0.1") {
  return post(auth, "/sign-in/email", {email, password}, ip);
}
