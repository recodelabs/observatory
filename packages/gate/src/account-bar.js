// The account panel: who is signed in, a sign-out button and, for admins, Settings (the user
// manager). The gate adds it to every dashboard page a signed-in user sees, as the page is
// served, so the static build doesn't change and read-only users see no admin link.
//
// On a Framework page it goes at the bottom of the sidebar (#observablehq-sidebar), and so opens
// and closes with it; the sidebar becomes a column so the panel sits at its foot, and stays in
// view when the sidebar scrolls. A page without the sidebar gets the panel fixed at the bottom
// left. Colours come from Framework's theme variables, with fallbacks for other pages.
import {escape} from "./pages/layout.js";

const STYLE = `<style>
#observablehq-sidebar:has(> #obs-account){display:flex;flex-direction:column}
#obs-account{font:12px/1.4 var(--sans-serif,system-ui,sans-serif);color:var(--theme-foreground,#1f2328);
  background:var(--theme-background-alt,#fff);box-sizing:border-box;display:flex;flex-direction:column;gap:4px;z-index:2}
#obs-account.obs-in-sidebar{margin-top:auto;position:sticky;bottom:-1rem;padding:.6rem .5rem 1rem;
  border-top:solid 1px var(--theme-foreground-faintest,#d0d7de)}
#obs-account.obs-floating{position:fixed;left:12px;bottom:12px;z-index:2147483000;max-width:min(272px,calc(100vw - 24px));
  padding:8px 10px;border:1px solid var(--theme-foreground-faintest,#d0d7de);border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
#obs-account .obs-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
#obs-account .obs-via{color:var(--theme-foreground-muted,#57606a);font-weight:400}
#obs-account .obs-actions{display:flex;gap:12px;align-items:center}
#obs-account a,#obs-account button{font:inherit;color:var(--theme-foreground-focus,#0b57d0);background:none;border:0;padding:0;cursor:pointer;text-decoration:none}
#obs-account a:hover,#obs-account button:hover{text-decoration:underline}
#obs-account form{margin:0}
</style>`;

export function accountBar(who, {admin}) {
  const via = who.provider && who.provider !== "email" ? ` <span class="obs-via">via ${escape(who.provider)}</span>` : "";
  const inner = `<div class="obs-who" title="${escape(who.user.email)}">${escape(who.user.email)}${via}</div>`
    + `<div class="obs-actions">`
    + (admin ? `<a href="/_obs/admin">Settings</a>` : "")
    + `<form method="post" action="/_obs/signout"><button type="submit">Sign out</button></form>`
    + `</div>`;
  return {
    sidebar: `${STYLE}<div id="obs-account" class="obs-in-sidebar">${inner}</div>`,
    floating: `${STYLE}<div id="obs-account" class="obs-floating">${inner}</div>`
  };
}

/** Add the panel to an HTML page response; anything else is returned as it is. */
export function withAccountBar(response, panel) {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  // The page now carries who is signed in, so it must never be shared or reused for someone else.
  headers.set("cache-control", "private, no-store");
  // At the end of Framework's sidebar; failing that, at the end of <body>; a page with neither
  // (a bare fragment) gets it at the end of the document.
  let placed = false;
  const rewritten = new HTMLRewriter()
    .on("#observablehq-sidebar", {element(el) { if (!placed) { el.append(panel.sidebar, {html: true}); placed = true; } }})
    .on("body", {element(el) { el.onEndTag((end) => { if (!placed) { end.before(panel.floating, {html: true}); placed = true; } }); }})
    .onDocument({end(end) { if (!placed) end.append(panel.floating, {html: true}); }})
    .transform(response);
  return new Response(rewritten.body, {status: 200, headers});
}
