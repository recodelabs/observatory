import {describe, it, expect} from "vitest";
import {loadConfig} from "../src/config.js";
import {compileAccess, decide, holds, isAdmin, statusOf, describeRule} from "../src/access.js";

const config = loadConfig({
  sites: [
    {name: "main", path: "/", access: "public"},
    {name: "ug", path: "/ug/", access: [{oidc: "uga", group: "/dashboards"}, {emailDomain: "ona.io"}]},
    {name: "team", path: "/team/"},
    {name: "off", path: "/off/", access: "disabled"}
  ],
  access: [{match: "team/about", allow: "public"}, {match: "ntd", allow: "disabled"}],
  auth: {admins: [{email: "boss@ona.io"}, {oidc: "uga", group: "/dashboards-admins"}], email: {allowedDomains: ["allowed.example"]}}
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
    [{sites: [{name: "a", path: "/"}], cloudflare: {sites: "../x/"}}, /cloudflare.sites/]
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
  it("applies the first matching exception, by path or clean URL", () => {
    expect(resolve("team/about").rule).toBe("public");
    expect(resolve("team/about.html").rule).toBe("public");
    expect(resolve("ntd").rule).toBe("disabled");
    expect(resolve("team/other").rule).toBe("signed-in");
  });
  it("makes Framework's runtime public only in a site with a public page, never the search index", () => {
    expect(resolve("team/_observablehq/client.js").rule).toBe("public");    // team/about is public
    expect(resolve("team/_npm/d3@7/x.js").rule).toBe("public");
    expect(resolve("team/_observablehq/minisearch.json").rule).toBe("signed-in");
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
  it("admins: by config (verified email, Keycloak group) or by stored role, and only while active", () => {
    expect(isAdmin(config, user("boss@ona.io"))).toBe(true);
    expect(isAdmin(config, user("boss@ona.io", {emailVerified: false}))).toBe(false);
    expect(isAdmin(config, user("x@y.z", {status: "active"}), new Map([["uga", {groups: ["/dashboards-admins"]}]]))).toBe(true);
    expect(isAdmin(config, user("x@y.z", {status: "active", role: "admin"}))).toBe(true);
    expect(isAdmin(config, user("x@y.z", {status: "disabled", role: "admin"}))).toBe(false);
    expect(isAdmin(config, user("boss@ona.io", {status: "disabled"}))).toBe(false);
  });
});

describe("decide", () => {
  const ug = config.sites[1].access;
  it("follows the order of checks", () => {
    expect(decide(config, "disabled", user("boss@ona.io"))).toEqual({kind: "notfound"});
    expect(decide(config, "public", null)).toEqual({kind: "serve", visibility: "public"});
    expect(decide(config, ug, null)).toEqual({kind: "login"});
    expect(decide(config, ug, user("x@ona.io", {status: "disabled"}))).toEqual({kind: "refused", reason: "disabled"});
    expect(decide(config, ug, user("x@elsewhere.org"))).toEqual({kind: "pending"});
    expect(decide(config, ug, user("boss@ona.io"))).toEqual({kind: "serve", visibility: "private"});
    expect(decide(config, ug, user("x@elsewhere.org", {status: "active"}))).toEqual({kind: "refused", reason: "rule"});
    expect(decide(config, ug, user("x@ona.io", {status: "active"}))).toEqual({kind: "serve", visibility: "private"});
    expect(decide(config, "signed-in", user("x@elsewhere.org", {status: "active"}))).toEqual({kind: "serve", visibility: "private"});
  });
  it("describes a rule for the 403 page", () => {
    expect(describeRule(ug)).toEqual(["members of the group /dashboards (sign in with uga)", "an account with a verified @ona.io address"]);
  });
});
