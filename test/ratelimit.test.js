import {env} from "cloudflare:workers";
import {describe, it, expect} from "vitest";
import {app} from "../src/index.js";
import {signUp, get, NAV} from "./helpers.js";

// Both tests in this file share D1 storage (per file), so order matters: the rate-limit
// test's sign-up needs its own unique IP (via the signUp helper) before the fixed-IP flood,
// and the D1-down test drops the session table, which must run last since it breaks
// storage for anything after it.
describe("rate limit", () => {
  it("blocks the 11th password attempt in a minute", async () => {
    await signUp("rl@example.org");
    const ip = "203.0.113.9";
    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.fetch(new Request("http://example.com/auth/sign-in/email", {
        method: "POST",
        headers: {"content-type": "application/json", origin: "http://example.com", "cf-connecting-ip": ip},
        body: JSON.stringify({email: "rl@example.org", password: "wrong wrong wrong"})
      }), env);
    }
    expect(last.status).toBe(429);
  });
});

describe("D1 down", () => {
  it("protected navigation is 503, never served", async () => {
    // Break the DB by dropping the session table for this test file's isolated storage.
    await env.DB.prepare("drop table session").run();
    const res = await get("/", {...NAV, cookie: "better-auth.session_token=abc"});
    expect(res.status).toBe(503);
  });
});
