import {describe, it, expect} from "vitest";
import {decide, isNavigation} from "../src/gate.js";

const active = {status: "active", role: "user"};
const admin = {status: "active", role: "admin"};
const pending = {status: "pending", role: "user"};
const disabled = {status: "disabled", role: "user"};

describe("decide", () => {
  it("disabled path is 404 for everyone", () => {
    for (const user of [null, active, admin, pending]) {
      expect(decide({access: "disabled", user, isNavigation: true, path: "ntd"})).toEqual({kind: "notfound"});
    }
  });
  it("public path serves for everyone", () => {
    for (const user of [null, active, pending, disabled]) {
      expect(decide({access: "public", user, isNavigation: false, path: "about"})).toEqual({kind: "serve"});
    }
  });
  it("protected + no session: redirect for navigation, 401 for fetch", () => {
    expect(decide({access: "protected", user: null, isNavigation: true, path: "coverage"}))
      .toEqual({kind: "redirect", to: "/_door/login?next=%2Fcoverage"});
    expect(decide({access: "protected", user: null, isNavigation: false, path: "_file/x.parquet"}))
      .toEqual({kind: "status", status: 401});
  });
  it("protected + pending/disabled: pending page for navigation, 403 for fetch", () => {
    for (const user of [pending, disabled]) {
      expect(decide({access: "protected", user, isNavigation: true, path: ""})).toEqual({kind: "redirect", to: "/_door/pending"});
      expect(decide({access: "protected", user, isNavigation: false, path: "_file/x"})).toEqual({kind: "status", status: 403});
    }
  });
  it("protected + active or admin serves", () => {
    expect(decide({access: "protected", user: active, isNavigation: true, path: ""})).toEqual({kind: "serve"});
    expect(decide({access: "protected", user: admin, isNavigation: false, path: "_file/x"})).toEqual({kind: "serve"});
  });
});

describe("isNavigation", () => {
  it("looks at Accept", () => {
    expect(isNavigation(new Request("http://x/", {headers: {accept: "text/html,application/xhtml+xml"}}))).toBe(true);
    expect(isNavigation(new Request("http://x/", {headers: {accept: "*/*"}}))).toBe(false);
    expect(isNavigation(new Request("http://x/"))).toBe(false);
  });
});
