const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", wasm: "application/wasm", parquet: "application/vnd.apache.parquet",
  pmtiles: "application/octet-stream", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  woff2: "font/woff2", woff: "font/woff", txt: "text/plain; charset=utf-8", map: "application/json"
};
const IMMUTABLE = /^(_npm|_import|_observablehq|_file)\//;

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

export async function serveFromR2(bucket, prefix, request, path, access) {
  const ranged = request.headers.has("range");
  const visibility = access === "public" ? "public" : "private";
  for (const key of candidates(path)) {
    const obj = await bucket.get(prefix + key, {range: ranged ? request.headers : undefined, onlyIf: request.headers});
    if (!obj) continue;
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set("content-type", contentType(key));
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", IMMUTABLE.test(key) ? `${visibility}, max-age=31536000, immutable` : `${visibility}, max-age=300`);
    const hasBody = "body" in obj && obj.body;
    const partial = ranged && obj.range && hasBody;
    if (partial) {
      const {offset = 0, length = obj.size - offset} = obj.range;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      headers.set("content-length", String(length));
    } else if (hasBody) headers.set("content-length", String(obj.size));
    const status = hasBody ? (partial ? 206 : 200) : 304;
    const body = status === 304 || request.method === "HEAD" ? null : obj.body;
    return new Response(body, {status, headers});
  }
  const notFound = await bucket.get(prefix + "404.html");
  const notFoundBody = request.method === "HEAD" ? null : notFound ? notFound.body : "Not found";
  return new Response(notFoundBody, {status: 404, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
}
