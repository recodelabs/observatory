import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {serveFromR2} from "../src/serve.js";
import {putSite, PREFIX} from "./helpers.js";

const req = (path, init) => new Request("http://example.com/" + path, init);
const serve = (path, access = "protected", init) => serveFromR2(env.SITE, PREFIX, req(path, init), path, access);

beforeAll(() => putSite(env, {
  "index.html": "<h1>home</h1>", "about.html": "<h1>about</h1>", "docs/index.html": "<h1>docs</h1>",
  "404.html": "<h1>nope</h1>", "_file/data/x.abc.parquet": new Uint8Array([1,2,3,4,5,6,7,8,9,10]),
  "_observablehq/client.js": "console.log(1)"
}));

describe("serveFromR2", () => {
  it("resolves cleanUrls", async () => {
    expect(await (await serve("")).text()).toBe("<h1>home</h1>");
    expect(await (await serve("about")).text()).toBe("<h1>about</h1>");
    expect(await (await serve("docs")).text()).toBe("<h1>docs</h1>");
    expect(await (await serve("docs/")).text()).toBe("<h1>docs</h1>");
  });
  it("sets content-type by extension", async () => {
    expect((await serve("about")).headers.get("content-type")).toMatch(/^text\/html/);
    expect((await serve("_file/data/x.abc.parquet")).headers.get("content-type")).toBe("application/vnd.apache.parquet");
  });
  it("serves ranges with 206 and content-range", async () => {
    const res = await serve("_file/data/x.abc.parquet", "protected", {headers: {range: "bytes=2-4"}});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([3,4,5]));
  });
  it("answers 304 on matching etag", async () => {
    const first = await serve("about");
    const res = await serve("about", "protected", {headers: {"if-none-match": first.headers.get("etag")}});
    expect(res.status).toBe(304);
  });
  it("cache-control: protected is private, public keeps campaignhq headers, hashed assets long-lived", async () => {
    expect((await serve("about", "protected")).headers.get("cache-control")).toBe("private, max-age=300");
    expect((await serve("about", "public")).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await serve("_observablehq/client.js", "protected")).headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await serve("_observablehq/client.js", "public")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
  it("404 uses the site's 404.html", async () => {
    const res = await serve("missing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>nope</h1>");
  });
  it("HEAD has no body", async () => {
    const res = await serve("about", "protected", {method: "HEAD"});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
