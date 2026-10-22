// Serving a site's files from R2, as the ICR's campaignhq Worker did: bucket keys mirror request
// paths under the sites folder (`_site/campaignhq/` + `ug/plan.html`), Framework's clean URLs,
// range requests, ETag/304, and a brotli copy of each .wasm file (name.wasm.br, made by
// `observatory build`) for browsers that accept brotli.
const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", wasm: "application/wasm", parquet: "application/vnd.apache.parquet",
  pmtiles: "application/octet-stream", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  woff2: "font/woff2", woff: "font/woff", txt: "text/plain; charset=utf-8", map: "application/json",
  csv: "text/csv; charset=utf-8", geojson: "application/geo+json"
};
// Framework's hashed files, at a site's root or in a nested site's folder.
const IMMUTABLE = /(^|\/)(_npm|_import|_observablehq|_file)\//;

function contentType(key) {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

/** Candidate object keys for a request path, Framework cleanUrls style. */
export function candidates(path) {
  if (path === "" || path.endsWith("/")) path += "index.html";
  const list = [path];
  if (!path.includes(".")) list.push(`${path}.html`, `${path}/index.html`);
  return list;
}

/**
 * Serve `path` from `prefix` in the bucket. `visibility` is "public" or "private" (the
 * cache-control a gated response must carry). `notFoundKey` is the site's 404 page.
 */
export async function serveFromR2(bucket, prefix, request, path, visibility, notFoundKey) {
  const ranged = request.headers.has("range");
  for (const key of candidates(path)) {
    // A folder site (ug/) is redirected to its trailing-slash URL, which its relative links need.
    if (key === `${path}/index.html`) {
      if (!(await bucket.head(prefix + key))) continue;
      const url = new URL(request.url);
      url.pathname = `/${path}/`;
      return new Response(null, {status: 301, headers: {location: url.pathname + url.search, "cache-control": visibility === "public" ? "public, max-age=300" : "private, no-cache"}});
    }
    const wasm = key.endsWith(".wasm");
    let obj = null, brotli = false;
    if (wasm && !ranged && /\bbr\b/.test(request.headers.get("accept-encoding") ?? "")) {
      obj = await bucket.get(prefix + key + ".br", {onlyIf: request.headers});
      brotli = obj !== null;
    }
    obj ??= await bucket.get(prefix + key, {range: ranged ? request.headers : undefined, onlyIf: request.headers});
    if (!obj) continue;
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set("content-type", contentType(key));
    headers.set("accept-ranges", "bytes");
    if (wasm) headers.set("vary", "accept-encoding");
    // A page differs with the cookie (the gate adds the account bar for a signed-in user), so a
    // browser must not reuse the anonymous copy once it has one.
    if (key.endsWith(".html")) headers.set("vary", "cookie");
    if (brotli) headers.set("content-encoding", "br");
    // A gated file must go back to the gate every time (no-cache: revalidated, a cheap 304),
    // so the browser can't reuse it after its user signs out or loses access. Public files
    // keep the long cache for Framework's hashed assets.
    headers.set("cache-control", visibility !== "public" ? "private, no-cache"
      : IMMUTABLE.test(key) ? "public, max-age=31536000, immutable" : "public, max-age=300");
    const hasBody = "body" in obj && obj.body;
    const partial = ranged && obj.range && hasBody;
    if (partial) {
      const {offset = 0, length = obj.size - offset} = obj.range;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      headers.set("content-length", String(length));
    } else if (hasBody) headers.set("content-length", String(obj.size));
    const status = hasBody ? (partial ? 206 : 200) : 304;
    const body = status === 304 || request.method === "HEAD" ? null : obj.body;
    // encodeBody "manual": the brotli copy is already encoded; don't compress it again.
    return new Response(body, {status, headers, encodeBody: brotli ? "manual" : "automatic"});
  }
  return notFound(bucket, prefix + notFoundKey, request);
}

export async function notFound(bucket, key, request) {
  const page = key ? await bucket.get(key) : null;
  const body = request.method === "HEAD" ? null : page ? page.body : "Not found";
  return new Response(body, {status: 404, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
}
