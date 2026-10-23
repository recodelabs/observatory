// The editor's GitHub access, through a GitHub App installed on the repo with `contents: write`.
// For every request the gate signs a short-lived JWT with the App's private key (the Worker
// secret GITHUB_APP_PRIVATE_KEY), exchanges it for an installation token limited to this one
// repository and `contents: write`, and calls the API with that. Neither token leaves the
// Worker: none goes in a response, an error message or a log.

const API = "https://api.github.com";
/** GitHub's contents API refuses larger files, and so does the editor. */
export const MAX_BYTES = 1024 * 1024;

/** Something went wrong talking to GitHub; `message` is safe to show an admin. */
export class GitHubError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}
/** The file changed on GitHub since the editor read it. */
export class Conflict extends GitHubError {
  constructor() {
    super("This file changed on GitHub since you opened it.", 409);
  }
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s) => new TextEncoder().encode(s);

/** Base64 of a UTF-8 string, and back, in pieces so a 1 MB file doesn't overflow the stack. */
export function encodeBase64(text) {
  const bytes = utf8(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
}

// DER length and the PKCS#8 wrapper for an RSA key. GitHub hands out PKCS#1 keys ("BEGIN RSA
// PRIVATE KEY"); WebCrypto imports only PKCS#8, so a PKCS#1 key is wrapped here.
function derLength(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (; n > 0; n >>= 8) out.unshift(n & 0xff);
  return [0x80 | out.length, ...out];
}
const der = (tag, body) => [tag, ...derLength(body.length), ...body];
function pkcs1ToPkcs8(pkcs1) {
  const algorithm = der(0x30, [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]); // rsaEncryption, NULL
  return new Uint8Array(der(0x30, [0x02, 0x01, 0x00, ...algorithm, ...der(0x04, [...pkcs1])]));
}

async function importKey(pem) {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(pem ?? "");
  if (!m) throw new GitHubError("The editor isn't set up: the Worker secret GITHUB_APP_PRIVATE_KEY is missing or isn't a private key.", 503);
  const raw = Uint8Array.from(atob(m[2].replace(/\s/g, "")), (c) => c.charCodeAt(0));
  try {
    return await crypto.subtle.importKey("pkcs8", m[1] ? pkcs1ToPkcs8(raw) : raw, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["sign"]);
  } catch {
    throw new GitHubError("The editor isn't set up: GITHUB_APP_PRIVATE_KEY couldn't be read as an RSA private key.", 503);
  }
}

/** The App's JWT: RS256, issued a minute ago to allow for clock drift, valid for 9 minutes. */
async function appJwt(app, pem) {
  const key = await importKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(utf8(JSON.stringify({alg: "RS256", typ: "JWT"})));
  const body = b64url(utf8(JSON.stringify({iat: now - 60, exp: now + 540, iss: app})));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function call(path, {token, method = "GET", body} = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "observatory-gate",
        authorization: `Bearer ${token}`,
        ...(body ? {"content-type": "application/json"} : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new GitHubError("Couldn't reach GitHub. Try again in a minute.");
  }
  const data = await res.json().catch(() => null);
  return {status: res.status, ok: res.ok, data};
}

const segments = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * A client for one repo, holding an installation token for this request only. `repo` is the
 * config's repo; `env` has GITHUB_APP_PRIVATE_KEY.
 */
export async function connect(repo, env) {
  if (!repo?.app) throw new GitHubError("The editor isn't set up: repo.app (the GitHub App's ID) is missing from the config.", 503);
  const jwt = await appJwt(repo.app, env.GITHUB_APP_PRIVATE_KEY);
  const where = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const inst = await call(`${where}/installation`, {token: jwt});
  if (inst.status >= 500) throw new GitHubError("GitHub isn't responding. Try again in a minute.");
  if (inst.status === 401) throw new GitHubError("GitHub didn't accept the App's key. Check repo.app and GITHUB_APP_PRIVATE_KEY.", 503);
  if (!inst.ok) throw new GitHubError(`The GitHub App isn't installed on ${repo.owner}/${repo.name}.`, 503);
  const tok = await call(`/app/installations/${inst.data.id}/access_tokens`, {token: jwt, method: "POST",
    body: {repositories: [repo.name], permissions: {contents: "write"}}});
  if (tok.status >= 500) throw new GitHubError("GitHub isn't responding. Try again in a minute.");
  if (!tok.ok || !tok.data?.token) throw new GitHubError(`GitHub wouldn't give the App write access to ${repo.owner}/${repo.name}.`, 503);
  const token = tok.data.token;

  return {
    /**
     * The Markdown files under `folder` on the branch: regular files (blobs, not symlinks or
     * submodules) ending in .md, as {path (relative to folder), sha, size}. Empty when the
     * folder doesn't exist.
     */
    async markdownFiles(folder) {
      // The folder's tree: the branch's own for the repo's top, else the folder's entry in its
      // parent's listing.
      let tree = encodeURIComponent(repo.branch);
      if (folder !== "") {
        const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
        const name = folder.slice(parent ? parent.length + 1 : 0);
        const list = await call(`${where}/contents/${segments(parent)}?ref=${encodeURIComponent(repo.branch)}`, {token});
        if (list.status === 404) return [];
        if (!list.ok || !Array.isArray(list.data)) throw new GitHubError("Couldn't list the files on GitHub.");
        const dir = list.data.find((e) => e.name === name && e.type === "dir");
        if (!dir) return [];
        tree = dir.sha;
      }
      const res = await call(`${where}/git/trees/${tree}?recursive=1`, {token});
      if (!res.ok) throw new GitHubError("Couldn't list the files on GitHub.");
      if (res.data.truncated) throw new GitHubError("This site has too many files for GitHub to list in one go.");
      return res.data.tree
        .filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755") && e.path.endsWith(".md"))
        .map((e) => ({path: e.path, sha: e.sha, size: e.size}))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    /** A file's text, by its blob SHA (from markdownFiles). */
    async read(sha) {
      const blob = await call(`${where}/git/blobs/${encodeURIComponent(sha)}`, {token});
      if (!blob.ok) throw new GitHubError("Couldn't read the file from GitHub.");
      try {
        return decodeBase64(blob.data.content);
      } catch {
        throw new GitHubError("This file isn't UTF-8 text.", 422);
      }
    },
    /**
     * Commit `text` to `path` (from the repo's top) on the branch, replacing the blob `sha` the
     * editor opened. Throws Conflict when the file has changed since. Returns the commit's SHA.
     */
    async save(path, {text, sha, message, author}) {
      const res = await call(`${where}/contents/${segments(path)}`, {token, method: "PUT",
        body: {message, content: encodeBase64(text), sha, branch: repo.branch, author}});
      if (res.status === 409) throw new Conflict();
      if (!res.ok) throw new GitHubError(`GitHub didn't save the file (${res.status}${res.data?.message ? `: ${String(res.data.message).slice(0, 200)}` : ""}).`);
      return res.data.commit.sha;
    }
  };
}
