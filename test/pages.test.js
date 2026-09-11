import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, setStatus, get, post, NAV} from "./helpers.js";

beforeAll(() => putSite(env, {"index.html": "<h1>home</h1>"}));

describe("login page", () => {
  it("renders with brand title and the next field", async () => {
    const res = await get("/_door/login?next=%2Fcoverage", NAV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Campaign Dashboards");
    expect(html).toContain('name="next" value="/coverage"');
    expect(html).toContain('action="/_door/magic"');
  });
  it("wrong password re-renders with an error, no cookie", async () => {
    await signUp("a@example.org");
    const res = await post("/_door/login", {email: "a@example.org", password: "nope nope nope", next: "/"});
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Invalid email or password/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("correct password sets the cookie and redirects to next", async () => {
    await signUp("b@example.org");
    const res = await post("/_door/login", {email: "b@example.org", password: "correct horse battery", next: "/coverage"});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/coverage");
    expect(res.headers.get("set-cookie")).toMatch(/better-auth\.session_token=/);
  });
  it("refuses an off-site next", async () => {
    await signUp("c@example.org");
    const res = await post("/_door/login", {email: "c@example.org", password: "correct horse battery", next: "https://evil.example/x"});
    expect(res.headers.get("location")).toBe("/");
  });
  it("magic link form answers with a 'check your email' page and logs the link", async () => {
    await signUp("m@example.org");
    const res = await post("/_door/magic", {email: "m@example.org", next: "/"});
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Check your email/);
  });
  it("signed-in active user visiting login is sent to next", async () => {
    const cookie = await signUp("d@example.org"); await setStatus("d@example.org", "active");
    const res = await get("/_door/login?next=%2Fabout", {...NAV, cookie});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/about");
  });
});

describe("signup and pending", () => {
  it("signup creates a pending user and redirects to /_door/pending", async () => {
    await signUp("zeroth@example.org"); // make sure the first-admin slot is taken before "new@example.org" below
    const res = await post("/_door/signup", {email: "new@example.org", password: "correct horse battery", name: "New"});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_door/pending");
    const row = await env.DB.prepare("select status from user where email = ?").bind("new@example.org").first();
    expect(row.status).toBe("pending");
  });
  it("duplicate signup re-renders with an error", async () => {
    await signUp("dup@example.org");
    const res = await post("/_door/signup", {email: "dup@example.org", password: "correct horse battery", name: "Dup"});
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/already/i);
  });
  it("pending page shows waiting text and sign-out works", async () => {
    const cookie = await signUp("w@example.org");
    const res = await get("/_door/pending", {...NAV, cookie});
    expect(await res.text()).toMatch(/waiting for approval/);
    const out = await post("/_door/signout", {}, {cookie});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/_door/login");
    expect(out.headers.get("set-cookie")).toMatch(/session_token=;|Max-Age=0/);
  });
  it("unknown /_door path is 404", async () => {
    expect((await get("/_door/whatever")).status).toBe(404);
  });
});
