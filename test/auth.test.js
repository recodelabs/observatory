import {env} from "cloudflare:workers";
import {describe, it, expect, vi} from "vitest";
import {createAuth} from "../src/auth.js";
import {loadConfig} from "../src/config.js";
import {readSession} from "../src/session.js";

const config = loadConfig({site: {name: "campaignhq"}, auth: {allowedDomains: ["ona.io"]}});

// These tests exercise createAuth directly (not through the Worker), because they need
// per-test config (allowedDomains, mail.adminNotify) that differs from doorman.config.js —
// the config the Worker's shared signUp/signIn helpers in helpers.js are wired to.
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

/** Creates an account through the real /auth endpoints. Returns the session cookie. */
function signUp(auth, email, password = PASSWORD, ip = "127.0.0.1") {
  return post(auth, "/sign-up/email", {email, password, name: email}, ip);
}

/** Signs an existing account in. Returns the session cookie. */
function signIn(auth, email, password = PASSWORD, ip = "127.0.0.1") {
  return post(auth, "/sign-in/email", {email, password}, ip);
}

describe("createAuth", () => {
  it("first user is admin + active; later users are pending; allowlisted domain is active", async () => {
    const auth = createAuth(env, config);
    await signUp(auth, "first@example.org");
    await signUp(auth, "second@example.org");
    await signUp(auth, "third@ona.io");
    const rows = await env.DB.prepare("select email, role, status from user order by createdAt").all();
    expect(rows.results).toEqual([
      {email: "first@example.org", role: "admin", status: "active"},
      {email: "second@example.org", role: "user", status: "pending"},
      {email: "third@ona.io", role: "user", status: "active"}
    ]);
  });
  it("readSession returns user with status and role from the cookie", async () => {
    const auth = createAuth(env, config);
    const cookie = await signUp(auth, "s@example.org");
    const got = await readSession(auth, new Request("http://example.com/", {headers: {cookie}}));
    expect(got.user.email).toBe("s@example.org");
    expect(got.user.status).toBe("admin" === got.user.role ? "active" : "pending");
    expect(await readSession(auth, new Request("http://example.com/"))).toBeNull();
    const again = await readSession(auth, new Request("http://example.com/", {headers: {cookie: await signIn(auth, "s@example.org")}}));
    expect(again.user.email).toBe("s@example.org");
  });
  it("readSession fails closed when storage is broken", async () => {
    const broken = createAuth({...env, DB: {prepare() { throw new Error("boom"); }}}, config);
    await expect(readSession(broken, new Request("http://example.com/", {headers: {cookie: "better-auth.session_token=x"}}))).rejects.toThrow(/unavailable/);
  });
  it("a magic link for an unknown email creates no account", async () => {
    const auth = createAuth(env, config);
    const mailed = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => void mailed.push(String(line)));
    try {
      const res = await auth.handler(new Request("http://example.com/auth/sign-in/magic-link", {
        method: "POST", headers: {"content-type": "application/json", origin: "http://example.com", "cf-connecting-ip": "127.0.0.1"},
        body: JSON.stringify({email: "nobody@example.org"})
      }));
      expect(res.status).toBeLessThan(500);
      // Better Auth 1.7.4 answers 200 and still sends the link (it does not leak whether the
      // address is known); disableSignUp is enforced when the link is followed. doorman's
      // /_door/magic form never reaches this endpoint for an unknown address — it looks the
      // user up first (src/pages/login.js) so the form cannot be used to mail strangers.
      const url = mailed.join("\n").match(/http:\/\/example\.com\/auth\/magic-link\/verify\S+/)?.[0];
      if (url) {
        const verified = await auth.handler(new Request(url, {headers: {origin: "http://example.com", "cf-connecting-ip": "127.0.0.1"}}));
        expect(verified.status).toBeLessThan(500);
        expect(verified.headers.get("location") ?? "").toMatch(/new_user_signup_disabled/);
      }
    } finally {
      log.mockRestore();
    }
    const {results} = await env.DB.prepare("select email from user where email = ?").bind("nobody@example.org").all();
    expect(results).toEqual([]);
  });
  it("a pending signup notifies the admin address when one is configured", async () => {
    const notifying = loadConfig({site: {name: "campaignhq"}, mail: {adminNotify: "admin@example.org"}});
    const auth = createAuth(env, notifying);
    const mailed = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => void mailed.push(String(line)));
    try {
      await signUp(auth, "pending@example.org", undefined, "10.0.0.1");
    } finally {
      log.mockRestore();
    }
    expect(mailed.join("\n")).toMatch(/to=admin@example\.org.*waiting for approval/s);
  });
});
