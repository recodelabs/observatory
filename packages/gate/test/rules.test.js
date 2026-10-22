import {describe, it, expect} from "vitest";
import {compileRules} from "../src/rules.js";

describe("compileRules", () => {
  it("defaults to protected", () => {
    expect(compileRules([])("index.html")).toBe("protected");
    expect(compileRules([])("_file/data/x.abc.parquet")).toBe("protected");
  });
  it("first match wins", () => {
    const r = compileRules([{match: "ntd", access: "disabled"}, {match: "ntd", access: "public"}]);
    expect(r("ntd")).toBe("disabled");
  });
  it("* stays within a segment, ** crosses segments", () => {
    const r = compileRules([{match: "_file/data/calendar.*.parquet", access: "public"}, {match: "ntd/**", access: "disabled"}]);
    expect(r("_file/data/calendar.abc123.parquet")).toBe("public");
    expect(r("_file/data/other/calendar.abc.parquet")).toBe("protected");
    expect(r("ntd/2026/index.html")).toBe("disabled");
    expect(r("ntd")).toBe("protected");
  });
  it("cleanUrl variants of a page match the page rule", () => {
    const r = compileRules([{match: "about", access: "public"}]);
    expect(r("about")).toBe("public");
    expect(r("about.html")).toBe("public");
    expect(r("about/index.html")).toBe("public");
    expect(r("aboutx")).toBe("protected");
  });
  it("runtime chunks go public only when some rule is public", () => {
    expect(compileRules([])("_observablehq/client.js")).toBe("protected");
    const r = compileRules([{match: "about", access: "public"}]);
    expect(r("_observablehq/client.js")).toBe("public");
    expect(r("_npm/duckdb/x.js")).toBe("public");
    expect(r("_import/chart.abc.js")).toBe("public");
    expect(r("_file/data/x.parquet")).toBe("protected");
  });
  it("an explicit rule on runtime chunks wins over auto-public", () => {
    const r = compileRules([{match: "_import/**", access: "protected"}, {match: "about", access: "public"}]);
    expect(r("_import/chart.js")).toBe("protected");
    expect(r("_npm/x.js")).toBe("public");
  });
  it("rejects unknown access values", () => {
    expect(() => compileRules([{match: "x", access: "private"}])).toThrow(/access/);
  });
});
