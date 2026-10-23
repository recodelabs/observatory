import {STYLE} from "./style.js";

export function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

const FONTS = "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&display=swap";

/**
 * A gate page, laid out like a Framework page: the site's title as the heading, the page's own
 * title under it (unless `heading` is false, as on the sign-in page, where the form says it), then
 * the body. `account` ({email}) adds a bar at the top with a link back to
 * the dashboards, the signed-in address and Sign out.
 */
export function page({config, title, body, message = null, error = null, wide = false, account = null, heading = true}) {
  const brand = config.brand;
  const logo = brand.logo ? `<img class="logo" src="${escape(brand.logo)}" alt="">` : "";
  const top = account ? `<nav class="top"><a href="/">← Back to the dashboards</a><span class="who"><span class="email">${escape(account.email)}</span>`
    + `<form method="post" action="/_obs/signout"><button type="submit" class="link">Sign out</button></form></span></nav>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · ${escape(brand.title)}</title><link rel="stylesheet" href="${FONTS}">
<style>${STYLE}${brand.accent ? `:root{--theme-foreground-focus:${escape(brand.accent)}}` : ""}</style></head>
<body><div class="shell${wide ? " wide" : ""}">${top}<main>${logo}<h1><a href="/">${escape(brand.title)}</a></h1>${heading ? `<h2>${escape(title)}</h2>` : ""}
${error ? `<div class="msg err" role="alert">${escape(error)}</div>` : ""}${message ? `<div class="msg" role="status">${escape(message)}</div>` : ""}
${body}</main></div></body></html>`;
}

export function html(c, markup, status = 200, extraHeaders = {}) {
  return new Response(markup, {status, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extraHeaders}});
}

/**
 * A `next` we are willing to redirect to: a path on this origin and nothing else.
 * Rejects protocol-relative (`//evil.com`) and backslash (`/\evil.com`, which browsers
 * normalise to `//evil.com`) forms, encoded slashes, control characters, and anything
 * that parses to a different origin.
 */
export function safeNext(next) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")
      || next.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(next)
      || /%2[fF]|%5[cC]/.test(next.split(/[?#]/)[0])) return "/";
  try {
    return new URL(next, "https://gate.invalid").origin === "https://gate.invalid" ? next : "/";
  } catch {
    return "/";
  }
}

/** Copy every set-cookie from Better Auth's response headers onto our redirect. */
export function withCookies(response, from) {
  const cookies = typeof from.getSetCookie === "function" ? from.getSetCookie() : [from.get("set-cookie")].filter(Boolean);
  for (const c of cookies) response.headers.append("set-cookie", c);
  return response;
}
