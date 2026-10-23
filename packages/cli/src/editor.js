// The local editor that `observatory dev` runs beside Framework's preview: a site's Markdown on
// the left, the preview on the right. Typing saves the file to disk after a short pause, and the
// preview, which watches the files, updates at once. Committing is left to git.
//
// It listens on 127.0.0.1 only. Other websites the browser has open could still send requests
// to it, so every save needs this run's random token in a header (which a page elsewhere can't
// add without a CORS preflight this server never answers), the Host must be this server, and an
// Origin, when sent, must be this server's. Only the site's existing .md pages can be read or
// written; anything else is refused, whatever its spelling.
import {createHash, randomBytes} from "node:crypto";
import {closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readSync, realpathSync, writeSync} from "node:fs";
import {createServer} from "node:http";
import {dirname, join, relative, sep} from "node:path";
import {spawnSync} from "node:child_process";

const MAX_BYTES = 1024 * 1024;
const hash = (text) => createHash("sha1").update(text).digest("hex");
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

/**
 * The site's pages: .md files under root, as paths relative to it with "/" separators. Like
 * Framework, it skips files and folders whose names start with "_" or "."; it also skips
 * node_modules and symlinks.
 */
export function pages(root) {
  const out = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith("_") || name.startsWith(".") || name === "node_modules") continue;
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && name.endsWith(".md")) out.push(relative(root, path).split(sep).join("/"));
    }
  })(root);
  return out;
}

/**
 * Open a page's file for reading and writing, checked again at the moment of use: its folder
 * must still resolve inside `root` and the file itself must be a regular file, not a symlink
 * (O_NOFOLLOW). Returns {fd, text}; the caller closes fd.
 */
function openPage(root, page) {
  const file = join(root, page);
  const top = realpathSync(root);
  const dir = realpathSync(dirname(file));
  if (dir !== top && !dir.startsWith(top + sep)) throw Object.assign(new Error("outside the site"), {status: 404});
  const fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error("not a file"), {status: 404});
    const buf = Buffer.alloc(st.size);
    for (let off = 0; off < st.size;) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (!n) break;
      off += n;
    }
    return {fd, text: buf.toString("utf8")};
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** Where Framework's preview shows a page: index.md is /, dir/index.md is /dir/. */
export function previewPath(page) {
  const p = page.replace(/\.md$/, "");
  return "/" + (p === "index" ? "" : p.endsWith("/index") ? p.slice(0, -"index".length) : p);
}

/** The site's pages with changes git hasn't committed, or null outside a git repo. */
function uncommitted(root) {
  const r = spawnSync("git", ["status", "--porcelain", "--", "."], {cwd: root, encoding: "utf8"});
  if (r.status !== 0) return null;
  return r.stdout.split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .map((p) => {
      const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {cwd: root, encoding: "utf8"}).stdout.trim();
      return relative(root, join(top, p)).split(sep).join("/");
    })
    .filter((p) => p.endsWith(".md") && !p.startsWith(".."));
}

const STYLE = `
:root{--serif:"Source Serif 4","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"avenir next",avenir,helvetica,"helvetica neue",ubuntu,roboto,noto,"segoe ui",arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --fg:#1b1e23;--focus:#3b5fc0;--bg:#fff;--bg-b:color-mix(in srgb,var(--fg) 4%,var(--bg));
  --muted:color-mix(in srgb,var(--fg) 60%,var(--bg));--faint:color-mix(in srgb,var(--fg) 14%,var(--bg));
  --ok:#3ca951;--warn:#efb118;--err:#c4402a;color-scheme:light}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg-b);color:var(--fg);font:14px/1.5 var(--sans)}
a[href]{color:var(--focus);text-decoration:none}a[href]:hover{text-decoration:underline}
.shell{max-width:760px;margin:0 auto;padding:3rem 16px}
h1{font:700 28px/1.2 var(--serif);margin:0 0 .25rem}
.sub{color:var(--muted);margin:0 0 1.5rem}
.card{background:var(--bg);border:1px solid var(--faint);border-radius:.75rem;padding:1rem 1.25rem;margin-bottom:1rem}
.card h2{font:700 14px var(--sans);margin:0 0 .5rem}
ul{margin:0;padding-left:1.25rem}ul.files{columns:14rem}li{break-inside:avoid}
code{font:13px var(--mono)}
.editor{display:flex;flex-direction:column;height:100%;padding:.75rem 16px 16px;gap:.75rem}
.bar{display:flex;gap:.5rem 1rem;align-items:center;flex-wrap:wrap}
.bar strong{font:700 17px var(--serif)}
.bar select{font:inherit;padding:.25rem .4rem;border:1px solid var(--faint);border-radius:6px;background:var(--bg);max-width:100%}
.status{margin-left:auto;color:var(--muted);white-space:nowrap}
.status::before{content:"";display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.4rem;background:var(--ok)}
.status.saving::before{background:var(--warn)}.status.err{color:var(--err)}.status.err::before{background:var(--err)}
.status button{font:inherit;color:var(--focus);background:none;border:0;padding:0;cursor:pointer;margin-left:.5rem}
.panes{flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.75rem;min-height:0}
.panes textarea,.panes iframe{width:100%;height:100%;border:1px solid var(--faint);border-radius:.75rem;background:var(--bg)}
.panes textarea{resize:none;padding:1rem;font:13px/1.55 var(--mono);color:var(--fg);tab-size:2}
.panes textarea:focus{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 20%,transparent)}
@media (max-width:760px){.panes{grid-template-columns:minmax(0,1fr);grid-template-rows:1fr 1fr}}
`;

const doc = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

// Saves after a pause in typing (and at once on Ctrl/Cmd-S), one request at a time; a change made
// while one is saving is sent after it. If the file changed on disk since it was read (another
// editor), it stops saving and offers to load that version; the text in the box stays.
const SCRIPT = `
const text = document.getElementById("text"), status = document.getElementById("status");
const {token, page} = document.body.dataset;
let base = document.body.dataset.base, timer = null, saving = false, again = false, stopped = false, saved = text.value;
const show = (cls, msg, reload) => {
  status.className = "status " + cls; status.textContent = msg;
  if (reload) { const b = document.createElement("button"); b.textContent = "Load it"; b.onclick = () => { stopped = false; location.reload(); }; status.append(b); }
};
async function save() {
  clearTimeout(timer);
  timer = null;
  if (stopped) return;
  if (saving) { again = true; return; }
  saving = true;
  try {
    do {
      again = false;
      show("saving", "Saving…");
      const sent = text.value;
      const res = await fetch("/save/" + page, {method: "POST", headers: {"content-type": "application/json", "x-observatory-token": token},
        body: JSON.stringify({text: sent, base})});
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) { stopped = true; show("err", "The file changed on disk, so typing here no longer saves.", true); return; }
      if (!res.ok) throw new Error(body.error || res.status);
      base = body.hash;
      saved = sent;
    } while (again);
    show("", "Saved to disk");
  } catch (e) {
    show("err", "Not saved: " + e.message);
  } finally {
    saving = false;
  }
}
text.addEventListener("input", () => { if (stopped) return; show("saving", "Unsaved"); clearTimeout(timer); timer = setTimeout(save, 400); });
text.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); text.setRangeText("  ", text.selectionStart, text.selectionEnd, "end"); text.dispatchEvent(new Event("input")); }
});
document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(); } });
document.getElementById("pages").addEventListener("change", (e) => { location.href = e.target.value; });
addEventListener("beforeunload", (e) => { if (timer || saving || text.value !== saved) e.preventDefault(); });
`;

/**
 * Start the editor for `site` (its name and source root), with Framework's preview at
 * `previewUrl`. Resolves with the server once it listens on 127.0.0.1:`port`.
 */
export function startEditor({name, root, previewUrl, port}) {
  const token = randomBytes(16).toString("hex");
  const here = `http://127.0.0.1:${port}`;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const editPath = (p) => "/edit/" + p.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/");

  /** The listed page a request path names (after /edit/ or /save/), or null. */
  function pageOf(rest) {
    if (/%2f|%5c/i.test(rest)) return null;
    let p;
    try { p = rest.split("/").map(decodeURIComponent).join("/") + ".md"; } catch { return null; }
    return pages(root).includes(p) ? p : null;
  }

  function list() {
    const all = pages(root);
    const changed = uncommitted(root);
    const items = all.map((p) => `<li><a href="${escape(editPath(p))}">${escape(p)}</a></li>`).join("");
    const git = changed === null ? "" : `<div class="card"><h2>Changed since your last commit</h2>`
      + (changed.length ? `<ul>${changed.map((p) => `<li>${escape(p)}</li>`).join("")}</ul><p class="sub" style="margin:.5rem 0 0">Commit them with git when you're happy, e.g. <code>git commit -am "…"</code>, then deploy.</p>` : `<p class="sub" style="margin:0">Nothing.</p>`)
      + `</div>`;
    return doc(`Edit ${name}`, `<div class="shell"><h1>Edit ${escape(name)}</h1>
<p class="sub">Pages in <code>${escape(root)}</code>. Typing saves to disk; the preview at <a href="${escape(previewUrl)}">${escape(previewUrl)}</a> updates as you go.</p>
<div class="card"><h2>Pages</h2>${items ? `<ul class="files">${items}</ul>` : "<p>No .md pages.</p>"}</div>${git}</div>`);
  }

  function editor(page) {
    const {fd, text} = openPage(root, page);
    closeSync(fd);
    const options = pages(root).map((p) => `<option value="${escape(editPath(p))}"${p === page ? " selected" : ""}>${escape(p)}</option>`).join("");
    const src = previewUrl.replace(/\/$/, "") + previewPath(page);
    // A textarea drops one newline straight after its start tag, so one goes in to keep a file's
    // own leading newline.
    return doc(`${page} · Edit ${name}`, `<div class="editor">
<div class="bar"><strong><a href="/">${escape(name)}</a></strong>
<select id="pages" aria-label="Page">${options}</select>
<a href="${escape(src)}" target="_blank" rel="noopener">Open the preview</a>
<span class="status" id="status" role="status">Saved to disk</span></div>
<div class="panes"><textarea id="text" spellcheck="false" aria-label="Markdown of ${escape(page)}">
${escape(text)}</textarea><iframe src="${escape(src)}" title="Preview of ${escape(page)}"></iframe></div>
</div><script>${SCRIPT}</script>`).replace("<body>", `<body data-token="${token}" data-page="${escape(page.replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/"))}" data-base="${hash(text)}">`);
  }

  const send = (res, status, body, type = "text/html; charset=utf-8") => {
    res.writeHead(status, {"content-type": type, "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer"});
    res.end(body);
  };
  const json = (res, status, body) => send(res, status, JSON.stringify(body), "application/json");

  const server = createServer((req, res) => {
    // A file error anywhere (a folder that can't be read, a page deleted while listing) is
    // answered, not thrown out of the server.
    try {
      handle(req, res);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (req.method === "POST") return json(res, 500, {error: `couldn't read the site's files (${e.code ?? e.message})`});
      send(res, 500, doc("Error", `<div class="shell"><h1>Couldn't read the site's files</h1><p>${escape(e.code ?? e.message)}</p></div>`));
    }
  });

  function handle(req, res) {
    if (!hosts.has(req.headers.host ?? "")) return send(res, 421, "Wrong host");
    const url = new URL(req.url, here);
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, list());
    if (req.method === "GET" && url.pathname.startsWith("/edit/")) {
      const page = pageOf(url.pathname.slice("/edit/".length));
      if (page) {
        try {
          return send(res, 200, editor(page));
        } catch (e) {
          return send(res, 500, doc("Error", `<div class="shell"><h1>Couldn't open ${escape(page)}</h1><p>${escape(e.code ?? e.message)}</p><p><a href="/">All pages</a></p></div>`));
        }
      }
      return send(res, 404, doc("Not found", `<div class="shell"><h1>No such page</h1><p><a href="/">All pages</a></p></div>`));
    }
    if (req.method === "POST" && url.pathname.startsWith("/save/")) {
      if (req.headers["x-observatory-token"] !== token) return json(res, 403, {error: "bad token"});
      if (req.headers.origin && req.headers.origin !== here && req.headers.origin !== `http://localhost:${port}`) return json(res, 403, {error: "bad origin"});
      const page = pageOf(url.pathname.slice("/save/".length));
      if (!page) return json(res, 404, {error: "no such page"});
      const chunks = [];
      let size = 0;
      req.on("data", (c) => { size += c.length; if (size <= MAX_BYTES * 2) chunks.push(c); });
      req.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, {error: "bad request"}); }
        if (typeof body?.text !== "string" || typeof body.base !== "string") return json(res, 400, {error: "bad request"});
        if (Buffer.byteLength(body.text) > MAX_BYTES) return json(res, 413, {error: "over 1 MB"});
        // The file is checked again now, after the body arrived, and written through the
        // descriptor that check opened.
        let fd;
        try {
          if (!pages(root).includes(page)) return json(res, 404, {error: "no such page"});
          let current;
          ({fd, text: current} = openPage(root, page));
          if (hash(current) !== body.base) return json(res, 409, {error: "changed on disk", hash: hash(current)});
          if (body.text !== current) {
            const out = Buffer.from(body.text, "utf8");
            ftruncateSync(fd, 0);
            for (let off = 0; off < out.length;) off += writeSync(fd, out, off, out.length - off, off);
          }
          json(res, 200, {hash: hash(body.text)});
        } catch (e) {
          json(res, e.status ?? 500, {error: e.status ? "no such page" : `couldn't write the file (${e.code ?? e.message})`});
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      });
      return;
    }
    send(res, 404, "Not found");
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
