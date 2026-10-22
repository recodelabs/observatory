import {env} from "cloudflare:workers";
import {createApp} from "../src/index.js";

// The suite's deployment config: a main site for signed-in users with one public and one
// disabled page, and a nested site at /ug/ open to one email domain. admin@example.org is an
// admin by config once verified; allowed.example addresses need no approval once verified.
// Sign-up policy variations live in auth.test.js, which builds its own.
export const BRAND = "Test Site";
export const PREFIX = "_site/test/";
export const CONFIG = {
  brand: {title: BRAND},
  cloudflare: {sites: PREFIX},
  sites: [
    {name: "main", path: "/", access: "signed-in"},
    {name: "ug", path: "/ug/", access: [{emailDomain: "team.example"}]}
  ],
  access: [{match: "about", allow: "public"}, {match: "ntd", allow: "disabled"}],
  auth: {admins: [{email: "admin@example.org"}], email: {allowedDomains: ["allowed.example"]}}
};
export const app = createApp(CONFIG);
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

/** Mark an address as confirmed, as following the verification link would. */
export async function verify(email) {
  await env.DB.prepare("update user set emailVerified = 1 where email = ?").bind(email).run();
}

// Calls the Hono app directly (app.fetch(request, env)) rather than going through
// exports.default.fetch (the Fetcher/service-binding entry point). exports.default.fetch
// routes every call through a shared RPC channel in @cloudflare/vitest-plugin's Workers
// pool, and empirically: any *second-or-later* exports.default.fetch call in a test file
// that touches D1 hangs, regardless of what the first call did or returned. So — do not
// call exports.default.fetch more than once per test file when any of those calls touches
// D1; go through app.fetch(request, env) via these helpers instead.
//
// Two accepted tradeoffs from that: (a) most requests in this suite no longer go through
// the actual `export default {fetch}` entrypoint the Worker ships — only the "non-GET to
// site paths is 405" test in routes.test.js still calls exports.default.fetch, since it's
// the last request in its file; (b) app.fetch is called with no `ctx` argument, so
// `ctx.waitUntil` is unavailable to code under test here (nothing in this app uses it yet).
//
// A side effect: app.fetch never auto-follows redirects (it's a direct handler call, not a
// real fetch()), so unlike exports.default.fetch there's no need for `redirect: "manual"`.
export const get = (path, headers = {}) => app.fetch(new Request("http://example.com" + path, {headers}), env);
export const NAV = {accept: "text/html,application/xhtml+xml"};

// Posts a form (application/x-www-form-urlencoded) through app.fetch — see the note above
// on why this goes through app.fetch rather than exports.default.fetch, and why there's no
// redirect: "manual" (app.fetch never follows redirects to begin with). Every call gets a
// fresh cf-connecting-ip so form posts don't trip Better Auth's per-IP rate limits when a
// test file posts many of them against shared D1 storage.
export const post = (path, fields = {}, headers = {}) => app.fetch(new Request("http://example.com" + path, {
  method: "POST",
  headers: {"content-type": "application/x-www-form-urlencoded", origin: "http://example.com", "cf-connecting-ip": nextIp(), ...headers},
  body: new URLSearchParams(fields).toString()
}), env);
