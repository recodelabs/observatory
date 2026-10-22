// The account bar: a small box the gate adds to every dashboard page a signed-in user sees,
// with who they are, a sign-out button and, for admins, a link to the user manager. It is added
// as the page is served, so the static build doesn't change and read-only users see no admin link.
import {escape} from "./pages/layout.js";

const STYLE = "position:fixed;right:12px;bottom:12px;z-index:2147483000;display:flex;gap:10px;align-items:center;"
  + "font:12px/1.4 system-ui,sans-serif;color:#1f2328;background:#fff;border:1px solid #d0d7de;border-radius:6px;"
  + "padding:6px 10px;box-shadow:0 1px 3px rgba(0,0,0,.12)";
const BUTTON = "font:inherit;color:#0b57d0;background:none;border:0;padding:0;cursor:pointer";

export function accountBar(who, {admin}) {
  const via = who.provider && who.provider !== "email" ? ` <span style="color:#57606a">(${escape(who.provider)})</span>` : "";
  return `<div id="obs-account" style="${STYLE}">`
    + `<span>${escape(who.user.email)}${via}</span>`
    + (admin ? `<a href="/_obs/admin" style="color:#0b57d0">Manage users</a>` : "")
    + `<form method="post" action="/_obs/signout" style="margin:0"><button type="submit" style="${BUTTON}">Sign out</button></form>`
    + `</div>`;
}

/** Add the bar to an HTML page response; anything else is returned as it is. */
export function withAccountBar(response, html) {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  // The page now carries who is signed in, so it must never be shared or reused for someone else.
  headers.set("cache-control", "private, no-store");
  // At the end of <body>; a page without one (a bare fragment) gets it at the end of the document.
  let placed = false;
  const rewritten = new HTMLRewriter()
    .on("body", {element(el) { el.append(html, {html: true}); placed = true; }})
    .onDocument({end(end) { if (!placed) end.append(html, {html: true}); }})
    .transform(response);
  return new Response(rewritten.body, {status: 200, headers});
}
