import {env} from "cloudflare:workers";
import {app} from "../src/index.js";

export const PREFIX = "_site/campaignhq/";
export async function putSite(env, files) {
  for (const [key, body] of Object.entries(files)) await env.SITE.put(PREFIX + key, body);
}

const PASSWORD = "correct horse battery";

// Better Auth rate-limits /sign-up/email and /sign-in/email per cf-connecting-ip, and D1
// storage is shared across tests within a file. A fresh IP per call keeps later tests from
// seeing 429s from earlier ones.
let ipCounter = 0;
function nextIp() {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

async function authPost(path, body) {
  return app.fetch(new Request("http://example.com/auth/" + path, {
    method: "POST",
    headers: {"content-type": "application/json", origin: "http://example.com", "cf-connecting-ip": nextIp()},
    body: JSON.stringify(body)
  }), env);
}

/** Creates an account through the real Worker routes. Returns the session cookie. */
export async function signUp(email) {
  const res = await authPost("sign-up/email", {email, password: PASSWORD, name: email});
  if (res.status !== 200) throw new Error(`sign-up ${res.status}: ${await res.text()}`);
  return res.headers.get("set-cookie").split(";")[0];
}

/** Signs an existing account in through the real Worker routes. Returns the session cookie. */
export async function signIn(email) {
  const res = await authPost("sign-in/email", {email, password: PASSWORD});
  if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${await res.text()}`);
  return res.headers.get("set-cookie").split(";")[0];
}

export async function setStatus(email, status) {
  await env.DB.prepare("update user set status = ? where email = ?").bind(status, email).run();
}

// Calls the Hono app directly (app.fetch(request, env)) rather than going through
// exports.default.fetch (the Fetcher/service-binding entry point). The two are equivalent
// for a single request, but exports.default.fetch routes every call through a shared RPC
// channel in @cloudflare/vitest-plugin's Workers pool — and empirically, a response with a
// zero-length body (our 401/403 "status" responses; see gate.js) sent over that channel
// blocks the *next* request that writes to D1 (e.g. a later signUp/signIn) until it times
// out. Calling app.fetch directly bypasses that channel and doesn't reproduce the hang. It
// also means redirects are never auto-followed (app.fetch just returns the 3xx Response),
// so unlike a real fetch() there's no need for `redirect: "manual"` here.
export const get = (path, headers = {}) => app.fetch(new Request("http://example.com" + path, {headers}), env);
export const NAV = {accept: "text/html,application/xhtml+xml"};
