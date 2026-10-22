import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {serveFromR2} from "../src/serve.js";
import {putSite, PREFIX} from "./helpers.js";

const req = (path, init) => new Request("http://example.com/" + path, init);
const serve = (path, visibility = "private", init) => serveFromR2(env.SITE, PREFIX, req(path, init), path, visibility, "404.html");

beforeAll(() => putSite(env, {
  "index.html": "<h1>home</h1>", "about.html": "<h1>about</h1>", "docs/index.html": "<h1>docs</h1>",
  "404.html": "<h1>nope</h1>", "_file/data/x.abc.parquet": new Uint8Array([1,2,3,4,5,6,7,8,9,10]),
  "_observablehq/client.js": "console.log(1)",
  "_npm/e.wasm": new Uint8Array([0, 97, 115, 109]), "_npm/e.wasm.br": new Uint8Array([9, 9]),
  "ug/_npm/x.js": "x"
}));

describe("serveFromR2", () => {
  it("resolves cleanUrls", async () => {
    expect(await (await serve("")).text()).toBe("<h1>home</h1>");
    expect(await (await serve("about")).text()).toBe("<h1>about</h1>");
    expect(await (await serve("docs/")).text()).toBe("<h1>docs</h1>");
  });
  it("redirects a folder to its trailing-slash URL, query kept", async () => {
    const res = await serveFromR2(env.SITE, PREFIX, req("docs?x=1"), "docs", "private", "404.html");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/docs/?x=1");
  });
  it("sets content-type by extension", async () => {
    expect((await serve("about")).headers.get("content-type")).toMatch(/^text\/html/);
    expect((await serve("_file/data/x.abc.parquet")).headers.get("content-type")).toBe("application/vnd.apache.parquet");
  });
  it("serves ranges with 206 and content-range", async () => {
    const res = await serve("_file/data/x.abc.parquet", "private", {headers: {range: "bytes=2-4"}});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([3,4,5]));
  });
  it("answers 304 on matching etag", async () => {
    const first = await serve("about");
    const res = await serve("about", "private", {headers: {"if-none-match": first.headers.get("etag")}});
    expect(res.status).toBe(304);
  });
  it("sends the brotli copy of a .wasm to a browser that accepts br, the plain file otherwise", async () => {
    const br = await serve("_npm/e.wasm", "public", {headers: {"accept-encoding": "gzip, br"}});
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("accept-encoding");
    const plain = await serve("_npm/e.wasm", "public");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
    const ranged = await serve("_npm/e.wasm", "public", {headers: {"accept-encoding": "br", range: "bytes=0-1"}});
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-encoding")).toBeNull();
  });
  it("cache-control: gated files are revalidated every time; public hashed assets are long-lived, in nested sites too", async () => {
    expect((await serve("about", "private")).headers.get("cache-control")).toBe("private, no-cache");
    expect((await serve("about", "public")).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await serve("_observablehq/client.js", "private")).headers.get("cache-control")).toBe("private, no-cache");
    expect((await serve("_observablehq/client.js", "public")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await serve("ug/_npm/x.js", "public")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
  it("404 uses the site's 404.html", async () => {
    const res = await serve("missing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>nope</h1>");
  });
  it("HEAD has no body", async () => {
    const res = await serve("about", "private", {method: "HEAD"});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
  it("HEAD to a missing path is 404 with no body", async () => {
    const res = await serve("missing", "private", {method: "HEAD"});
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
  it("falls back to a plain 404 when the site has no 404.html", async () => {
    const res = await serveFromR2(env.SITE, "_site/empty/", req("missing"), "missing", "private", "404.html");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});
