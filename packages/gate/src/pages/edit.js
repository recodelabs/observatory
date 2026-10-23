// The editor: admins edit a dashboard page's Markdown in the gate, and each save commits that
// one file to the config's repo and branch through the GitHub App (src/github.js). A save
// doesn't change the live site; the page changes at the next deploy.
//
//   /_obs/edit/                  every site's Markdown pages
//   /_obs/edit/<site>/<page>     one page: its Markdown beside the live page; POST saves it
//
// Every request checks, on the server, that the user is an admin now. The files that can be
// opened are the existing .md files in the site's folder on GitHub, listed for each request;
// a request names one by site and its path in that list, and anything else is refused.
import {Hono} from "hono";
import {page, html, escape} from "./layout.js";
import {csrfToken, checkCsrf} from "./csrf.js";
import {isAdmin} from "../access.js";
import {connect, GitHubError, Conflict, MAX_BYTES} from "../github.js";

export const edit = new Hono();

edit.use("/edit", (c, next) => requireEditor(c, next));
edit.use("/edit/*", (c, next) => requireEditor(c, next));
// As on the admin page: anyone but an admin gets a plain 404, and so does everyone when the
// config names no repo.
async function requireEditor(c, next) {
  const s = c.get("session");
  if (!c.get("config").repo || !s?.user || !isAdmin(c.get("config"), s)) return c.text("Not found", 404);
  await next();
}

/** The sites that can be edited: those with a folder in the repo. */
const editable = (config) => config.sites.filter((s) => s.dir !== null);
/** The site's Markdown folder, from the top of the repo. */
const folderOf = (config, site) => [config.repo.root, site.dir, site.root].filter(Boolean).join("/");
/** The address of a page's file in the editor: /_obs/edit/<site>/<path without .md>. */
const editUrl = (site, file) => `/_obs/edit/${encodeURIComponent(site.name)}/${file.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/")}`;
/** Where a page's file shows on the site, as Framework builds it with clean URLs. */
function viewUrl(site, file) {
  const p = file.replace(/\.md$/, "");
  return "/" + site.prefix + (p === "index" ? "" : p.endsWith("/index") ? p.slice(0, -"index".length) : p);
}
const repoLabel = (repo) => `${repo.owner}/${repo.name} (${repo.branch})`;

function failure(c, config, err) {
  if (!(err instanceof GitHubError)) throw err;
  return html(c, page({config, title: "Edit", wide: true, account: {email: c.get("session").user.email},
    error: err.message, body: `<p class="note"><a href="/_obs/edit/">All pages</a></p>`}), err.status);
}

edit.get("/edit", (c) => c.redirect("/_obs/edit/", 301));
edit.get("/edit/", async (c) => {
  const config = c.get("config");
  try {
    const gh = await connect(config.repo, c.env);
    const sections = [];
    for (const site of editable(config)) {
      const files = await gh.markdownFiles(folderOf(config, site));
      const items = files.map((f) => `<li><a href="${escape(editUrl(site, f.path))}">${escape(f.path)}</a></li>`).join("");
      sections.push(`<div class="card"><h3>${escape(site.name)} <span class="muted">${escape(site.path)}</span></h3>`
        + (items ? `<ul class="files">${items}</ul>` : `<p class="note">No Markdown pages in ${escape(folderOf(config, site))}.</p>`) + `</div>`);
    }
    const body = `<p class="note">Saving a page commits it to ${escape(repoLabel(config.repo))} on GitHub. The site changes at the next deploy.</p>`
      + (sections.join("") || `<div class="card">No site has a folder in the repo (<code>dir</code> in the config).</div>`);
    return html(c, page({config, title: "Edit a page", body, wide: true, account: {email: c.get("session").user.email}}));
  } catch (err) {
    return failure(c, config, err);
  }
});

/** The site and the file name a request names, before checking the list, or null. */
function requested(c) {
  const site = editable(c.get("config")).find((s) => s.name === c.req.param("site"));
  if (!site) return null;
  // The rest of the path, as the browser sent it: matched against the listed names only, so
  // "..", encoded slashes and the like name nothing.
  const rest = new URL(c.req.url).pathname.slice(`/_obs/edit/${encodeURIComponent(site.name)}/`.length);
  if (/%2f|%5c/i.test(rest)) return null;
  try {
    return {site, name: rest.split("/").map(decodeURIComponent).join("/") + ".md"};
  } catch {
    return null;
  }
}

/** The site and the listed file a request names, or null. Throws GitHubError. */
async function lookup(c, gh) {
  const want = requested(c);
  if (!want) return null;
  const folder = folderOf(c.get("config"), want.site);
  const file = (await gh.markdownFiles(folder)).find((f) => f.path === want.name);
  return file ? {site: want.site, file, path: [folder, file.path].filter(Boolean).join("/")} : null;
}

function editorPage(c, {site, file, text, sha, note = "", dirty = false, message, error, status = 200}) {
  const config = c.get("config");
  return csrfToken(c.env.BETTER_AUTH_SECRET, c.get("session").session.token).then((csrf) => {
    const action = editUrl(site, file.path);
    // A textarea drops one newline straight after its start tag, so one goes in to keep a
    // file's own leading newline.
    // dirty: the text in the box is a save that failed, so leaving still asks first.
    const body = `<form method="post" action="${escape(action)}" class="editor" id="editor"${dirty ? " data-dirty" : ""}>
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="sha" value="${escape(sha)}">
<div class="edit-grid">
  <textarea name="text" id="text" spellcheck="false" aria-label="Markdown of ${escape(site.name)}/${escape(file.path)}">
${escape(text)}</textarea>
  <iframe src="${escape(viewUrl(site, file.path))}" title="The live page"></iframe>
</div>
<div class="actions">
  <input type="text" name="note" maxlength="200" value="${escape(note)}" placeholder="What changed (optional)" aria-label="What changed (optional)">
  <button type="submit" class="primary">Save to GitHub</button>
</div>
<p class="note">Saving commits this file to ${escape(repoLabel(config.repo))}. The live page, on the right, changes at the next deploy.
<a href="/_obs/edit/">All pages</a></p>
</form>
<script>${EDITOR_SCRIPT}</script>`;
    return html(c, page({config, title: `${site.name}/${file.path}`, body, wide: true, message, error,
      account: {email: c.get("session").user.email}}), status);
  });
}

// Tab indents instead of leaving the box, Ctrl/Cmd-S saves, and leaving with unsaved changes asks
// first.
const EDITOR_SCRIPT = `
const form = document.getElementById("editor"), text = document.getElementById("text");
const saved = "dirty" in form.dataset ? null : text.value;
let submitting = false;
text.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    text.setRangeText("  ", text.selectionStart, text.selectionEnd, "end");
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); form.requestSubmit(); }
});
form.addEventListener("submit", () => { submitting = true; });
addEventListener("beforeunload", (e) => { if (!submitting && text.value !== saved) e.preventDefault(); });
`;

const SAVED = {unchanged: "Nothing changed, so nothing was saved."};

edit.get("/edit/:site/:page{.+}", async (c) => {
  const config = c.get("config");
  try {
    const gh = await connect(config.repo, c.env);
    const found = await lookup(c, gh);
    if (!found) return failure(c, config, new GitHubError("There's no Markdown file for this page in the repo, so it can't be edited here.", 404));
    if (found.file.size > MAX_BYTES) return failure(c, config, new GitHubError("This file is over 1 MB, too big to edit here.", 413));
    const text = await gh.read(found.file.sha);
    const commit = c.req.query("commit");
    const ok = c.req.query("ok");
    const message = ok === "saved" && /^[0-9a-f]{7,40}$/.test(commit ?? "")
      ? `Saved as commit ${commit.slice(0, 7)} on ${config.repo.branch}. The live page changes at the next deploy.`
      : SAVED[ok] ?? null;
    return editorPage(c, {...found, text, sha: found.file.sha, message});
  } catch (err) {
    return failure(c, config, err);
  }
});

edit.post("/edit/:site/:page{.+}", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  // Saves come only from the editor page on this host, with the session's CSRF token.
  if (c.req.header("origin") !== new URL(c.env.BASE_URL).origin) return c.text("Bad origin", 403);
  const form = await c.req.parseBody();
  if (!(await checkCsrf(c.env.BETTER_AUTH_SECRET, s.session.token, form.csrf))) return c.text("Bad token", 403);
  if (typeof form.text !== "string" || typeof form.sha !== "string" || !/^[0-9a-f]{40}$/.test(form.sha)) return c.text("Bad request", 400);
  // Browsers send a textarea's line breaks as CRLF; the files use LF.
  const text = form.text.replace(/\r\n?/g, "\n");
  if (new TextEncoder().encode(text).length > MAX_BYTES) return c.text("Too large", 413);
  const note = typeof form.note === "string" ? form.note.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  let found = null;
  try {
    const gh = await connect(config.repo, c.env);
    found = await lookup(c, gh);
    if (!found) return failure(c, config, new GitHubError("There's no Markdown file for this page in the repo, so it can't be saved here.", 404));
    const here = editUrl(found.site, found.file.path);
    if (form.sha === found.file.sha && (await gh.read(found.file.sha)) === text) return c.redirect(`${here}?ok=unchanged`, 302);
    const commit = await gh.save(found.path, {text, sha: form.sha,
      message: `Edit ${found.site.name}/${found.file.path}${note ? `: ${note}` : ""}`,
      author: {name: s.user.name || s.user.email, email: s.user.email}});
    return c.redirect(`${here}?ok=saved&commit=${commit}`, 302);
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    // Keep what they typed, the note and the version they opened, so nothing is lost: after a
    // conflict, saving again fails the same way until they reload the version on GitHub; after
    // any other failure they can try again.
    const want = found ?? requested(c);
    if (!want) return failure(c, config, err);
    const file = found ? found.file : {path: want.name};
    return editorPage(c, {site: want.site, file, text, sha: form.sha, note, dirty: true, status: err.status,
      error: err instanceof Conflict
        ? "Someone changed this file on GitHub since you opened it, so your edit wasn't saved. Copy your changes, then reload the page to get the latest version."
        : `Your edit wasn't saved. ${err.message}`});
  }
});
