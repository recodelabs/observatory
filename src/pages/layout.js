import {STYLE} from "./style.js";

export function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

export function page({config, title, body, message = null, error = null, wide = false}) {
  const brand = config.brand;
  const logo = brand.logo ? `<img src="${escape(brand.logo)}" alt="" style="height:32px;margin-bottom:12px">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · ${escape(brand.title)}</title><style>${STYLE}:root{--accent:${escape(brand.accent)}}</style></head>
<body><main class="${wide ? "wide" : ""}"><div class="card">${logo}<h1>${escape(title)}</h1>
${error ? `<div class="msg err">${escape(error)}</div>` : ""}${message ? `<div class="msg">${escape(message)}</div>` : ""}
${body}</div><p class="muted" style="text-align:center;font-size:12px">${escape(brand.title)}</p></main></body></html>`;
}

export function html(c, markup, status = 200, extraHeaders = {}) {
  return new Response(markup, {status, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extraHeaders}});
}

export function safeNext(next) {
  return typeof next === "string" && /^\/(?!\/)/.test(next) ? next : "/";
}

/** Copy every set-cookie from Better Auth's response headers onto our redirect. */
export function withCookies(response, from) {
  const cookies = typeof from.getSetCookie === "function" ? from.getSetCookie() : [from.get("set-cookie")].filter(Boolean);
  for (const c of cookies) response.headers.append("set-cookie", c);
  return response;
}
