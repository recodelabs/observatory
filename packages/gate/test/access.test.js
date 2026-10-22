import {describe, it, expect} from "vitest";
import {loadConfig} from "../src/config.js";
import {compileAccess, decide, holds, isAdmin, statusOf, describeRule, pageKey} from "../src/access.js";

const config = loadConfig({
  sites: [
    {name: "main", path: "/", access: "public"},
    {name: "ug", path: "/ug/", access: [{oidc: "uga", group: "/dashboards"}, {emailDomain: "ona.io"}]},
    {name: "team", path: "/team/"},
    {name: "off", path: "/off/", access: "disabled"}
  ],
  access: [{match: "team/about", allow: "public"}],
  auth: {admins: [{email: "boss@ona.io"}, {oidc: "uga", group: "/dashboards-admins"}], email: {allowedDomains: ["allowed.example"]},
    oidc: [{id: "uga", name: "Uganda", issuer: "https://auth.example.org/realms/uga"}]}
});
const resolve = compileAccess(config);
const user = (email, extra = {}) => ({email, emailVerified: true, status: "pending", role: "user", ...extra});

describe("config", () => {
  it("defaults a site without access to signed-in", () => {
    expect(config.sites.find((s) => s.name === "team").access).toBe("signed-in");
  });
  it.each([
    [{sites: []}, /at least one site/],
    [{sites: [{name: "a", path: "a"}]}, /path/],
    [{sites: [{name: "a", path: "/"}, {name: "b", path: "/"}]}, /used twice/],
    [{sites: [{name: "a", path: "/", access: "everyone"}]}, /signed-in/],
    [{sites: [{name: "a", path: "/", access: [{group: "/x"}]}]}, /unknown condition/],
    [{sites: [{name: "a", path: "/"}], auth: {admins: [{role: "admin"}]}}, /unknown condition/],
    [{sites: [{name: "a", path: "/"}], access: [{match: "/x", allow: "public"}]}, /leading/],
    [{sites: [{name: "a", path: "/"}], access: [{match: "x", allow: "signed-in"}]}, /only "public"/],
    [{sites: [{name: "a", path: "/"}], access: [{match: "x", allow: "disabled"}]}, /only "public"/],
    [{sites: [{name: "a", path: "/"}], cloudflare: {sites: "../x/"}}, /cloudflare.sites/],
    [{sites: [{name: "a", path: "/", access: [{oidc: "nope", group: "/g"}]}]}, /no provider "nope"/],
    [{sites: [{name: "a", path: "/"}], auth: {oidc: [{id: "email", issuer: "https://x.org/r"}]}}, /not "email"/],
    [{sites: [{name: "a", path: "/"}], auth: {oidc: [{id: "k", issuer: "http://x.org/r"}]}}, /https/]
  ])("rejects %j", (raw, error) => {
    expect(() => loadConfig(raw)).toThrow(error);
  });
});

describe("resolve", () => {
  it("picks the site with the longest path, and its rule", () => {
    expect(resolve("").site.name).toBe("main");
    expect(resolve("coverage").rule).toBe("public");
    expect(resolve("ug/plan").site.name).toBe("ug");
    expect(resolve("ug").site.name).toBe("ug");
    expect(resolve("ug/_file/data/t.parquet").rule).toEqual(config.sites[1].access);
    expect(resolve("off/x").rule).toBe("disabled");
  });
  it("applies an exception to every URL of the page", () => {
    for (const p of ["team/about", "team/about/", "team/about.html", "team/about/index", "team/about/index.html"]) {
      expect(resolve(p).rule).toBe("public");
    }
    expect(resolve("team/other").rule).toBe("signed-in");
  });
  it("gives every alias of a page one name", () => {
    expect(["secret", "secret/", "secret.html", "secret/index", "secret/index.html"].map(pageKey)).toEqual(Array(5).fill("secret"));
    expect(["", "index", "index.html"].map(pageKey)).toEqual(["", "", ""]);
  });
  it("makes Framework's runtime public only in a site with a public page, never the search index", () => {
    expect(resolve("team/_observablehq/client.js").rule).toBe("public");    // team/about is public
    expect(resolve("team/_npm/d3@7/x.js").rule).toBe("public");
    expect(resolve("team/_observablehq/minisearch.json").rule).toBe("signed-in");
    expect(resolve("team/_observablehq/minisearch.6c0f2a1e.json").rule).toBe("signed-in");
    expect(resolve("team/_import/components/x.js").rule).toBe("signed-in");
    expect(resolve("ug/_observablehq/client.js").rule).toEqual(config.sites[1].access);
  });
});

describe("who is who", () => {
  it("email conditions need a verified address", () => {
    expect(holds({emailDomain: "ona.io"}, {user: user("a@ona.io")})).toBe(true);
    expect(holds({emailDomain: "ona.io"}, {user: user("a@ona.io", {emailVerified: false})})).toBe(false);
    expect(holds({email: "boss@ona.io"}, {user: user("BOSS@ona.io")})).toBe(true);
  });
  it("group and role conditions read the provider's claims", () => {
    const claims = new Map([["uga", {groups: ["/dashboards"], roles: ["viewer"]}]]);
    expect(holds({oidc: "uga", group: "/dashboards"}, {user: user("x@y.z"), claims})).toBe(true);
    expect(holds({oidc: "other", group: "/dashboards"}, {user: user("x@y.z"), claims})).toBe(false);
    expect(holds({oidc: "uga", role: "viewer"}, {user: user("x@y.z"), claims})).toBe(true);
  });
  it("status: stored disabled wins; allowed domain and admin emails are active once verified", () => {
    expect(statusOf(config, user("a@allowed.example"))).toBe("active");
    expect(statusOf(config, user("a@allowed.example", {emailVerified: false}))).toBe("pending");
    expect(statusOf(config, user("boss@ona.io"))).toBe("active");
    expect(statusOf(config, user("boss@ona.io", {status: "disabled"}))).toBe("disabled");
    expect(statusOf(config, user("x@elsewhere.org"))).toBe("pending");
  });
  it("a Keycloak session is active; stored disabled still wins", () => {
    expect(statusOf(config, user("x@elsewhere.org"), "uga")).toBe("active");
    expect(statusOf(config, user("x@elsewhere.org", {status: "disabled"}), "uga")).toBe("disabled");
  });
  it("admins: by config (verified email, Keycloak group) or by stored role, and only while active", () => {
    const admins = new Map([["uga", {groups: ["/dashboards-admins"]}]]);
    expect(isAdmin(config, {user: user("boss@ona.io")})).toBe(true);
    expect(isAdmin(config, {user: user("boss@ona.io", {emailVerified: false})})).toBe(false);
    expect(isAdmin(config, {user: user("x@y.z"), claims: admins, provider: "uga"})).toBe(true);
    expect(isAdmin(config, {user: user("x@y.z", {status: "active", role: "admin"})})).toBe(true);
    expect(isAdmin(config, {user: user("x@y.z", {status: "disabled", role: "admin"})})).toBe(false);
    expect(isAdmin(config, {user: user("boss@ona.io", {status: "disabled"})})).toBe(false);
    expect(isAdmin(config, {user: user("x@y.z", {status: "disabled"}), claims: admins, provider: "uga"})).toBe(false);
  });
});

describe("decide", () => {
  const ug = config.sites[1].access;
  it("follows the order of checks", () => {
    const w = (u, extra = {}) => ({user: u, ...extra});
    expect(decide(config, "disabled", w(user("boss@ona.io")))).toEqual({kind: "notfound"});
    expect(decide(config, "public", null)).toEqual({kind: "serve", visibility: "public"});
    expect(decide(config, ug, null)).toEqual({kind: "login"});
    expect(decide(config, ug, w(user("x@ona.io", {status: "disabled"})))).toEqual({kind: "refused", reason: "disabled"});
    expect(decide(config, ug, w(user("x@elsewhere.org")))).toEqual({kind: "pending"});
    expect(decide(config, ug, w(user("boss@ona.io")))).toEqual({kind: "serve", visibility: "private"});
    expect(decide(config, ug, w(user("x@elsewhere.org", {status: "active"})))).toEqual({kind: "refused", reason: "rule"});
    expect(decide(config, ug, w(user("x@ona.io", {status: "active"})))).toEqual({kind: "serve", visibility: "private"});
    expect(decide(config, "signed-in", w(user("x@elsewhere.org", {status: "active"})))).toEqual({kind: "serve", visibility: "private"});
  });
  it("a group counts only in a session signed in with its provider", () => {
    const ug = config.sites[1].access;
    const claims = new Map([["uga", {groups: ["/dashboards"]}]]);
    expect(decide(config, ug, {user: user("x@elsewhere.org"), claims, provider: "uga"})).toEqual({kind: "serve", visibility: "private"});
    // The same user in an email session: no claims (session.js gives an email session none).
    expect(decide(config, ug, {user: user("x@elsewhere.org", {status: "active"}), claims: new Map(), provider: "email"})).toEqual({kind: "refused", reason: "rule"});
  });
  it("describes a rule for the 403 page", () => {
    expect(describeRule(ug)).toEqual(["members of the group /dashboards (sign in with uga)", "an account with a verified @ona.io address"]);
  });
});
