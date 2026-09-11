import {env} from "cloudflare:workers";
import {describe, it, expect, vi} from "vitest";
import {createAuth} from "../src/auth.js";
import {loadConfig} from "../src/config.js";
import {readSession} from "../src/session.js";
import {signUp, signIn} from "./helpers.js";

const config = loadConfig({site: {name: "campaignhq"}, auth: {allowedDomains: ["ona.io"]}});

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
      // address is known); disableSignUp is enforced when the link is followed.
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
