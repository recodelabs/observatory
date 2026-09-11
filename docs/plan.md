# doorman Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker, in a new `recodelabs/doorman` repo, that serves a static site build from R2 behind Better Auth login, with per-path public/protected/disabled rules, admin approval of new accounts, and a minimal admin page. First deployment protects ICR's campaignhq.

**Architecture:** One Hono app. `/auth/*` is Better Auth (D1 through Kysely). `/_door/*` are Worker-rendered HTML pages (login, signup, pending, admin). Everything else resolves a page rule, runs a pure gate decision against the session, and streams the object from R2 using the serving logic lifted from `icr/campaignhq/worker/index.js`. Config is a plain ES module, `doorman.config.js`, imported by the Worker so wrangler bundles it.

**Tech Stack:** Cloudflare Workers (`nodejs_compat`), Hono 4, Better Auth 1.7 (plugins: magic-link, admin), Kysely + kysely-d1, D1, R2, Resend HTTP API, Vitest 4 with `@cloudflare/vitest-plugin` 1.x, wrangler 4. Plain JavaScript with JSDoc, no TypeScript build step.

**Spec:** `docs/spec.md` (copied from the icr repo, PR #171).

## Global Constraints

- Runtime is Cloudflare Workers only. `compatibility_flags: ["nodejs_compat"]` (Better Auth needs AsyncLocalStorage).
- Bindings: D1 `DB`, R2 `SITE`. Secrets: `BETTER_AUTH_SECRET`, `RESEND_API_KEY` (optional; console fallback when unset). Var: `BASE_URL`.
- Route order in the Worker is fixed: `/auth/*` → `/_door/*` → page rules → gate → R2 serve.
- Default access for any unmatched path is `protected`. Unknown `/_door/*` paths are 404. Disabled paths are 404 for everyone.
- The gate fails closed: any D1 error while reading a session is a 503.
- Protected responses carry `Cache-Control: private`. Public responses keep the campaignhq headers (`public, max-age=300`, hashed assets `public, max-age=31536000, immutable`).
- Unauthenticated protected request: navigation (`Accept` contains `text/html`) → 302 to `/_door/login?next=<path>`; otherwise 401 with empty body. Pending/disabled user: navigation → 302 `/_door/pending`; otherwise 403.
- Site objects live in R2 under `_site/<config.site.name>/`.
- User `status` values: `pending`, `active`, `disabled`. First user ever created is `admin` + `active`.
- No client-side framework in the Worker's pages. Forms post to `/_door/*` handlers, which call `auth.api.*` server-side and forward `set-cookie`.
- Commit after every task with a message ending in the session trailer used in this repo.

---

## File structure

```
doorman/
  README.md                 what it is, quick start, config reference, rollout notes
  docs/spec.md              copy of the design spec
  package.json
  wrangler.jsonc            bindings, nodejs_compat, routes (per deployment)
  vitest.config.js          cloudflareTest plugin, D1 migrations into TEST_MIGRATIONS
  doorman.config.js         per deployment (site, brand, auth, mail, pages)
  migrations/0001_auth.sql  Better Auth core + admin plugin + rateLimit + status column
  deploy.sh                 build site → rclone sync → d1 migrations apply → wrangler deploy
  scripts/check-rules.js    warns when a public HTML rule has no public _file/ rule
  src/
    index.js                Hono app + route order
    config.js               loads doorman.config.js, validates, fills defaults
    rules.js                compileRules(pages) → resolveAccess(path)          [pure]
    gate.js                 decide({access, user, isNavigation}) → decision    [pure]
    serve.js                serveFromR2(bucket, prefix, request, path, access)
    auth.js                 createAuth(env, config): Better Auth instance per request
    session.js              readSession(auth, request) with fail-closed wrapper
    mail.js                 sendMail(env, {to, subject, text}): Resend or console
    users.js                Kysely queries the admin page needs (list, setStatus, count)
    pages/
      layout.js             page(title, body, {brand, message}) → HTML string
      style.js              CSS string
      login.js              GET /_door/login, POST /_door/login, POST /_door/magic
      signup.js             GET/POST /_door/signup
      pending.js            GET /_door/pending, POST /_door/signout
      admin.js              GET /_door/admin, POST /_door/admin/<action>
      csrf.js               token = HMAC(session.token) helpers
  test/
    apply-migrations.js
    helpers.js              putSite(env, files), signUp(email), signIn(email) → cookie
    rules.test.js  gate.test.js  serve.test.js  auth.test.js
    routes.test.js  pages.test.js  admin.test.js  mail.test.js  ratelimit.test.js
```

---

### Task 1: Repo scaffold and test harness

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `vitest.config.js`, `test/apply-migrations.js`, `doorman.config.js`, `src/index.js` (placeholder), `migrations/0001_auth.sql`, `docs/spec.md`, `.gitignore`, `README.md` (title only for now)
- Test: `test/smoke.test.js`

**Interfaces:**
- Produces: the `Env` shape every later task assumes: `env.DB` (D1), `env.SITE` (R2), `env.BASE_URL`, `env.BETTER_AUTH_SECRET`, `env.RESEND_API_KEY?`, `env.TEST_MIGRATIONS` (tests only).

- [ ] **Step 1: Create the repo**

```bash
gh repo create recodelabs/doorman --private --description "Login and access control in front of a static site build (Observable Framework first). Cloudflare Worker + Better Auth + D1 + R2." --clone
cd doorman
cp ~/github/icr/docs/superpowers/specs/2026-09-11-doorman-design.md docs/spec.md 2>/dev/null || (mkdir -p docs && cp ~/github/icr/.claude/worktrees/of-vault-spec/docs/superpowers/specs/2026-09-11-doorman-design.md docs/spec.md)
```

- [ ] **Step 2: package.json**

```json
{
  "name": "doorman",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Login and access control in front of a static site build. Cloudflare Worker + Better Auth + D1 + R2.",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "deploy": "./deploy.sh",
    "check-rules": "node scripts/check-rules.js"
  },
  "dependencies": {
    "better-auth": "^1.7.4",
    "hono": "^4.13.7",
    "kysely": "^0.29.5",
    "kysely-d1": "^0.4.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "^1.1.8",
    "vitest": "^4.1.0",
    "wrangler": "^4.131.1"
  },
  "engines": {"node": ">=20"}
}
```

Run `npm install`.

- [ ] **Step 3: wrangler.jsonc**

```jsonc
{
  "name": "doorman",
  "main": "src/index.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "vars": {"BASE_URL": "http://localhost:8787"},
  "d1_databases": [
    {"binding": "DB", "database_name": "doorman", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations"}
  ],
  "r2_buckets": [{"binding": "SITE", "bucket_name": "icr"}]
  // routes and account_id are added per deployment in Task 11
}
```

- [ ] **Step 4: migrations/0001_auth.sql**

Better Auth's core schema for the Kysely adapter, plus the admin plugin's columns, the `rateLimit` table (rate limiting with `storage: "database"`), and our `status` column. Column names are camelCase because that is what the Kysely adapter emits by default.

```sql
CREATE TABLE "user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "role" TEXT,
  "banned" INTEGER DEFAULT 0,
  "banReason" TEXT,
  "banExpires" DATE,
  "status" TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE "session" (
  "id" TEXT PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "impersonatedBy" TEXT
);
CREATE INDEX "session_userId" ON "session"("userId");
CREATE TABLE "account" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);
CREATE INDEX "account_userId" ON "account"("userId");
CREATE TABLE "verification" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE,
  "updatedAt" DATE
);
CREATE INDEX "verification_identifier" ON "verification"("identifier");
CREATE TABLE "rateLimit" (
  "id" TEXT PRIMARY KEY,
  "key" TEXT,
  "count" INTEGER,
  "lastRequest" INTEGER
);
```

After Task 4 exists, cross-check this file with `npx @better-auth/cli@latest generate --config src/auth-cli.js --output /tmp/generated.sql` if the CLI can import the config; if column names differ, fix this migration, never the code. The e2e sign-up test in Task 4 is the real check.

- [ ] **Step 5: vitest.config.js and the migrations setup file**

```js
// vitest.config.js
import path from "node:path";
import {cloudflareTest, readD1Migrations} from "@cloudflare/vitest-plugin";
import {defineConfig} from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      wrangler: {configPath: "./wrangler.jsonc"},
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
          BASE_URL: "http://example.com"
        }
      }
    })],
    test: {setupFiles: ["./test/apply-migrations.js"]}
  };
});
```

```js
// test/apply-migrations.js
import {applyD1Migrations} from "cloudflare:test";
import {env} from "cloudflare:workers";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 6: doorman.config.js (local dev defaults)**

```js
// doorman.config.js — per-deployment settings. Imported by the Worker; wrangler bundles it.
export default {
  site: {name: "campaignhq", dist: "../icr/campaignhq/dist"},
  brand: {title: "Campaign Dashboards", accent: "#0b57d0", logo: null},
  auth: {allowedDomains: [], sessionDays: 30},
  mail: {from: "doorman@healthcampaigns.org", adminNotify: null},
  pages: []
};
```

- [ ] **Step 7: Placeholder Worker and smoke test**

```js
// src/index.js
export default {
  async fetch() { return new Response("doorman", {status: 200}); }
};
```

```js
// test/smoke.test.js
import {env, exports} from "cloudflare:workers";
import {it, expect} from "vitest";

it("worker answers and bindings exist", async () => {
  const res = await exports.default.fetch("http://example.com/");
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("select count(*) as n from user").first();
  expect(row.n).toBe(0);
  await env.SITE.put("_site/campaignhq/probe.txt", "hi");
  expect(await (await env.SITE.get("_site/campaignhq/probe.txt")).text()).toBe("hi");
});
```

- [ ] **Step 8: Run tests**

Run: `npm test`
Expected: 1 passed. If migrations fail to apply, the SQL in Step 4 has a syntax error; fix it before continuing.

- [ ] **Step 9: .gitignore and commit**

```
node_modules/
.wrangler/
.dev.vars
dist/
```

```bash
git add -A && git commit -m "Scaffold doorman: wrangler, vitest with D1 migrations, config, smoke test"
```

---

### Task 2: Page rules

**Files:**
- Create: `src/rules.js`
- Test: `test/rules.test.js`

**Interfaces:**
- Produces: `compileRules(pages: Array<{match: string, access: "public"|"protected"|"disabled"}>) → (path: string) => "public"|"protected"|"disabled"`. `path` has no leading slash. Throws on an invalid `access` value.
- Rule: first match wins, unmatched → `protected`. If any rule is `public`, the prefixes `_observablehq/`, `_npm/`, `_import/` resolve to `public` unless an explicit rule matches them first.

- [ ] **Step 1: Write the failing tests**

```js
// test/rules.test.js
import {describe, it, expect} from "vitest";
import {compileRules} from "../src/rules.js";

describe("compileRules", () => {
  it("defaults to protected", () => {
    expect(compileRules([])("index.html")).toBe("protected");
    expect(compileRules([])("_file/data/x.abc.parquet")).toBe("protected");
  });
  it("first match wins", () => {
    const r = compileRules([{match: "ntd", access: "disabled"}, {match: "ntd", access: "public"}]);
    expect(r("ntd")).toBe("disabled");
  });
  it("* stays within a segment, ** crosses segments", () => {
    const r = compileRules([{match: "_file/data/calendar.*.parquet", access: "public"}, {match: "ntd/**", access: "disabled"}]);
    expect(r("_file/data/calendar.abc123.parquet")).toBe("public");
    expect(r("_file/data/other/calendar.abc.parquet")).toBe("protected");
    expect(r("ntd/2026/index.html")).toBe("disabled");
    expect(r("ntd")).toBe("protected");
  });
  it("cleanUrl variants of a page match the page rule", () => {
    const r = compileRules([{match: "about", access: "public"}]);
    expect(r("about")).toBe("public");
    expect(r("about.html")).toBe("public");
    expect(r("about/index.html")).toBe("public");
    expect(r("aboutx")).toBe("protected");
  });
  it("runtime chunks go public only when some rule is public", () => {
    expect(compileRules([])("_observablehq/client.js")).toBe("protected");
    const r = compileRules([{match: "about", access: "public"}]);
    expect(r("_observablehq/client.js")).toBe("public");
    expect(r("_npm/duckdb/x.js")).toBe("public");
    expect(r("_import/chart.abc.js")).toBe("public");
    expect(r("_file/data/x.parquet")).toBe("protected");
  });
  it("an explicit rule on runtime chunks wins over auto-public", () => {
    const r = compileRules([{match: "_import/**", access: "protected"}, {match: "about", access: "public"}]);
    expect(r("_import/chart.js")).toBe("protected");
    expect(r("_npm/x.js")).toBe("public");
  });
  it("rejects unknown access values", () => {
    expect(() => compileRules([{match: "x", access: "private"}])).toThrow(/access/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/rules.test.js`
Expected: FAIL, cannot find module `../src/rules.js`.

- [ ] **Step 3: Implement**

```js
// src/rules.js
const ACCESS = new Set(["public", "protected", "disabled"]);
const RUNTIME_PREFIXES = ["_observablehq/", "_npm/", "_import/"];

/** Glob → RegExp. `*` matches within a segment, `**` across segments. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (".+?^${}()|[]\\".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

/** Strip Framework cleanUrl suffixes so `about`, `about.html`, `about/index.html` all test as `about`. */
function pageKey(path) {
  if (path.endsWith("/index.html")) return path.slice(0, -"/index.html".length);
  if (path === "index.html") return "";
  if (path.endsWith(".html")) return path.slice(0, -".html".length);
  return path;
}

export function compileRules(pages = []) {
  const compiled = pages.map(({match, access}) => {
    if (!ACCESS.has(access)) throw new Error(`rule ${JSON.stringify(match)}: access must be public, protected or disabled, got ${JSON.stringify(access)}`);
    return {re: globToRegExp(match), access};
  });
  const anyPublic = compiled.some((r) => r.access === "public");
  return function resolveAccess(path) {
    const key = pageKey(path);
    for (const {re, access} of compiled) if (re.test(path) || re.test(key)) return access;
    if (anyPublic && RUNTIME_PREFIXES.some((p) => path.startsWith(p))) return "public";
    return "protected";
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/rules.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/rules.js test/rules.test.js && git commit -m "rules: glob page rules with first-match, cleanUrl keys, runtime auto-public"
```

---

### Task 3: Gate decision table

**Files:**
- Create: `src/gate.js`
- Test: `test/gate.test.js`

**Interfaces:**
- Consumes: `access` from Task 2.
- Produces: `decide({access, user, isNavigation, path}) → {kind: "serve"} | {kind: "notfound"} | {kind: "redirect", to: string} | {kind: "status", status: number}`. `user` is `null` or `{status, role}`. Also `isNavigation(request) → boolean` (true when the `Accept` header contains `text/html`).

- [ ] **Step 1: Write the failing tests**

```js
// test/gate.test.js
import {describe, it, expect} from "vitest";
import {decide, isNavigation} from "../src/gate.js";

const active = {status: "active", role: "user"};
const admin = {status: "active", role: "admin"};
const pending = {status: "pending", role: "user"};
const disabled = {status: "disabled", role: "user"};

describe("decide", () => {
  it("disabled path is 404 for everyone", () => {
    for (const user of [null, active, admin, pending]) {
      expect(decide({access: "disabled", user, isNavigation: true, path: "ntd"})).toEqual({kind: "notfound"});
    }
  });
  it("public path serves for everyone", () => {
    for (const user of [null, active, pending, disabled]) {
      expect(decide({access: "public", user, isNavigation: false, path: "about"})).toEqual({kind: "serve"});
    }
  });
  it("protected + no session: redirect for navigation, 401 for fetch", () => {
    expect(decide({access: "protected", user: null, isNavigation: true, path: "coverage"}))
      .toEqual({kind: "redirect", to: "/_door/login?next=%2Fcoverage"});
    expect(decide({access: "protected", user: null, isNavigation: false, path: "_file/x.parquet"}))
      .toEqual({kind: "status", status: 401});
  });
  it("protected + pending/disabled: pending page for navigation, 403 for fetch", () => {
    for (const user of [pending, disabled]) {
      expect(decide({access: "protected", user, isNavigation: true, path: ""})).toEqual({kind: "redirect", to: "/_door/pending"});
      expect(decide({access: "protected", user, isNavigation: false, path: "_file/x"})).toEqual({kind: "status", status: 403});
    }
  });
  it("protected + active or admin serves", () => {
    expect(decide({access: "protected", user: active, isNavigation: true, path: ""})).toEqual({kind: "serve"});
    expect(decide({access: "protected", user: admin, isNavigation: false, path: "_file/x"})).toEqual({kind: "serve"});
  });
});

describe("isNavigation", () => {
  it("looks at Accept", () => {
    expect(isNavigation(new Request("http://x/", {headers: {accept: "text/html,application/xhtml+xml"}}))).toBe(true);
    expect(isNavigation(new Request("http://x/", {headers: {accept: "*/*"}}))).toBe(false);
    expect(isNavigation(new Request("http://x/"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/gate.test.js` → FAIL, module not found.

- [ ] **Step 3: Implement**

```js
// src/gate.js
export function isNavigation(request) {
  return (request.headers.get("accept") || "").includes("text/html");
}

/**
 * Pure decision for one request. `user` is null (no session) or {status, role}.
 * `path` has no leading slash; it is only used to build the login redirect.
 */
export function decide({access, user, isNavigation, path}) {
  if (access === "disabled") return {kind: "notfound"};
  if (access === "public") return {kind: "serve"};
  if (!user) {
    return isNavigation
      ? {kind: "redirect", to: `/_door/login?next=${encodeURIComponent("/" + path)}`}
      : {kind: "status", status: 401};
  }
  if (user.status !== "active") {
    return isNavigation ? {kind: "redirect", to: "/_door/pending"} : {kind: "status", status: 403};
  }
  return {kind: "serve"};
}
```

- [ ] **Step 4: Run tests** → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/gate.js test/gate.test.js && git commit -m "gate: pure decision table for access × session × navigation"
```

---

### Task 4: R2 static serving

**Files:**
- Create: `src/serve.js`
- Test: `test/serve.test.js`, `test/helpers.js`

**Interfaces:**
- Produces: `serveFromR2(bucket, prefix, request, path, access) → Promise<Response>`. `prefix` like `_site/campaignhq/`. `access` is `"public"` or `"protected"` and only changes cache headers. Missing object → 404 with the site's `404.html` if present.
- Produces (test helper): `putSite(env, files: Record<string,string|Uint8Array>)` writes each key under `_site/campaignhq/`.

- [ ] **Step 1: Test helper**

```js
// test/helpers.js
export const PREFIX = "_site/campaignhq/";
export async function putSite(env, files) {
  for (const [key, body] of Object.entries(files)) await env.SITE.put(PREFIX + key, body);
}
```

- [ ] **Step 2: Write the failing tests**

```js
// test/serve.test.js
import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {serveFromR2} from "../src/serve.js";
import {putSite, PREFIX} from "./helpers.js";

const req = (path, init) => new Request("http://example.com/" + path, init);
const serve = (path, access = "protected", init) => serveFromR2(env.SITE, PREFIX, req(path, init), path, access);

beforeAll(() => putSite(env, {
  "index.html": "<h1>home</h1>", "about.html": "<h1>about</h1>", "docs/index.html": "<h1>docs</h1>",
  "404.html": "<h1>nope</h1>", "_file/data/x.abc.parquet": new Uint8Array([1,2,3,4,5,6,7,8,9,10]),
  "_observablehq/client.js": "console.log(1)"
}));

describe("serveFromR2", () => {
  it("resolves cleanUrls", async () => {
    expect(await (await serve("")).text()).toBe("<h1>home</h1>");
    expect(await (await serve("about")).text()).toBe("<h1>about</h1>");
    expect(await (await serve("docs")).text()).toBe("<h1>docs</h1>");
    expect(await (await serve("docs/")).text()).toBe("<h1>docs</h1>");
  });
  it("sets content-type by extension", async () => {
    expect((await serve("about")).headers.get("content-type")).toMatch(/^text\/html/);
    expect((await serve("_file/data/x.abc.parquet")).headers.get("content-type")).toBe("application/vnd.apache.parquet");
  });
  it("serves ranges with 206 and content-range", async () => {
    const res = await serve("_file/data/x.abc.parquet", "protected", {headers: {range: "bytes=2-4"}});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([3,4,5]));
  });
  it("answers 304 on matching etag", async () => {
    const first = await serve("about");
    const res = await serve("about", "protected", {headers: {"if-none-match": first.headers.get("etag")}});
    expect(res.status).toBe(304);
  });
  it("cache-control: protected is private, public keeps campaignhq headers, hashed assets long-lived", async () => {
    expect((await serve("about", "protected")).headers.get("cache-control")).toBe("private, max-age=300");
    expect((await serve("about", "public")).headers.get("cache-control")).toBe("public, max-age=300");
    expect((await serve("_observablehq/client.js", "protected")).headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await serve("_observablehq/client.js", "public")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
  it("404 uses the site's 404.html", async () => {
    const res = await serve("missing");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("<h1>nope</h1>");
  });
  it("HEAD has no body", async () => {
    const res = await serve("about", "protected", {method: "HEAD"});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
```

- [ ] **Step 3: Run to verify failure** → FAIL, module not found.

- [ ] **Step 4: Implement** (lifted from `icr/campaignhq/worker/index.js`, minus host redirect, plus the `access` cache switch)

```js
// src/serve.js
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
  return new Response(notFound ? notFound.body : "Not found", {status: 404, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
}
```

- [ ] **Step 5: Run tests** → all pass. If the 304 test fails because `obj.range` handling differs in miniflare, check `"body" in obj` semantics: R2 returns an `R2Object` without `body` on a precondition failure.

- [ ] **Step 6: Commit**

```bash
git add src/serve.js test/serve.test.js test/helpers.js && git commit -m "serve: R2 static serving lifted from campaignhq with private cache for protected paths"
```

---

### Task 5: Better Auth on D1, status field, first-user admin, session reader

**Files:**
- Create: `src/config.js`, `src/auth.js`, `src/session.js`, `src/mail.js` (console-only for now)
- Test: `test/auth.test.js`; extend `test/helpers.js`

**Interfaces:**
- Produces: `loadConfig() → config` with defaults filled (`auth.sessionDays` 30, `auth.allowedDomains` [], `pages` []).
- Produces: `createAuth(env, config) → auth` (a Better Auth instance, `basePath: "/auth"`). Endpoints used later: `auth.handler(request)`, `auth.api.getSession({headers})`, `auth.api.signInEmail({body, headers, returnHeaders: true})`, `auth.api.signUpEmail(...)`, `auth.api.signInMagicLink({body, headers})`, `auth.api.signOut({headers, returnHeaders: true})`, `auth.api.listUsers({query, headers})`, `auth.api.setRole({body, headers})`, `auth.api.removeUser({body, headers})`.
- Produces: `readSession(auth, request) → Promise<{user, session} | null>`; throws `SessionUnavailable` on any storage error (the Worker maps that to 503).
- Produces: `sendMail(env, config, {to, subject, text}) → Promise<void>`; console fallback when `env.RESEND_API_KEY` is unset. Resend path is Task 9.
- Produces (helper): `signUp(email, password?) → cookie string`, `signIn(email, password?) → cookie string`, using the Worker's `/auth/*` endpoints.

- [ ] **Step 1: config.js**

```js
// src/config.js
import userConfig from "../doorman.config.js";

export function loadConfig(raw = userConfig) {
  if (!raw?.site?.name) throw new Error("doorman.config.js: site.name is required");
  return {
    site: {name: raw.site.name, dist: raw.site.dist ?? null},
    brand: {title: raw.brand?.title ?? raw.site.name, accent: raw.brand?.accent ?? "#0b57d0", logo: raw.brand?.logo ?? null},
    auth: {allowedDomains: (raw.auth?.allowedDomains ?? []).map((d) => d.toLowerCase()), sessionDays: raw.auth?.sessionDays ?? 30},
    mail: {from: raw.mail?.from ?? "doorman@localhost", adminNotify: raw.mail?.adminNotify ?? null},
    pages: raw.pages ?? []
  };
}
```

- [ ] **Step 2: mail.js (console fallback only, Resend comes in Task 9)**

```js
// src/mail.js
export async function sendMail(env, config, {to, subject, text}) {
  if (!env.RESEND_API_KEY) {
    console.log(`[doorman mail] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return;
  }
  throw new Error("Resend sender not implemented yet");
}
```

- [ ] **Step 3: Write the failing tests**

```js
// test/auth.test.js
import {env} from "cloudflare:workers";
import {describe, it, expect} from "vitest";
import {createAuth} from "../src/auth.js";
import {loadConfig} from "../src/config.js";
import {readSession} from "../src/session.js";

const config = loadConfig({site: {name: "campaignhq"}, auth: {allowedDomains: ["ona.io"]}});

async function signUp(auth, email) {
  const res = await auth.handler(new Request("http://example.com/auth/sign-up/email", {
    method: "POST", headers: {"content-type": "application/json", origin: "http://example.com"},
    body: JSON.stringify({email, password: "correct horse battery", name: email})
  }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie");
}

describe("createAuth", () => {
  it("first user is admin + active; later users are pending; allowlisted domain is active", async () => {
    const auth = createAuth(env, config);
    await signUp(auth, "first@example.org");
    await signUp(auth, "second@example.org");
    await signUp(auth, "third@ona.io");
    const rows = await env.DB.prepare("select email, role, status from user order by createdAt").all();
    expect(rows.results).toEqual([
      {email: "first@example.org", role: "admin", status: "active"},
      {email: "second@example.org", role: "user", status: "pending"},
      {email: "third@ona.io", role: "user", status: "active"}
    ]);
  });
  it("readSession returns user with status and role from the cookie", async () => {
    const auth = createAuth(env, config);
    const cookie = await signUp(auth, "s@example.org");
    const got = await readSession(auth, new Request("http://example.com/", {headers: {cookie}}));
    expect(got.user.email).toBe("s@example.org");
    expect(got.user.status).toBe("admin" === got.user.role ? "active" : "pending");
    expect(await readSession(auth, new Request("http://example.com/"))).toBeNull();
  });
  it("readSession fails closed when storage is broken", async () => {
    const broken = createAuth({...env, DB: {prepare() { throw new Error("boom"); }}}, config);
    await expect(readSession(broken, new Request("http://example.com/", {headers: {cookie: "better-auth.session_token=x"}}))).rejects.toThrow(/unavailable/);
  });
});
```

- [ ] **Step 4: Run to verify failure** → FAIL, modules not found.

- [ ] **Step 5: Implement auth.js**

```js
// src/auth.js
import {betterAuth} from "better-auth";
import {magicLink} from "better-auth/plugins/magic-link";
import {admin} from "better-auth/plugins/admin";
import {Kysely} from "kysely";
import {D1Dialect} from "kysely-d1";
import {sendMail} from "./mail.js";

/** One Better Auth instance per request: Workers only expose bindings at request time. */
export function createAuth(env, config) {
  const db = new Kysely({dialect: new D1Dialect({database: env.DB})});
  return betterAuth({
    baseURL: env.BASE_URL,
    basePath: "/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: {db, type: "sqlite"},
    trustedOrigins: [env.BASE_URL],
    emailAndPassword: {enabled: true, minPasswordLength: 10, autoSignIn: true},
    session: {expiresIn: config.auth.sessionDays * 24 * 60 * 60, updateAge: 24 * 60 * 60},
    rateLimit: {enabled: true, storage: "database", window: 60, max: 60,
      customRules: {"/sign-in/email": {window: 60, max: 10}, "/sign-in/magic-link": {window: 60, max: 5}, "/sign-up/email": {window: 60, max: 5}}},
    user: {
      additionalFields: {
        status: {type: "string", required: false, defaultValue: "pending", input: false}
      }
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const {n} = await db.selectFrom("user").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
            const first = Number(n) === 0;
            const domain = String(user.email).toLowerCase().split("@")[1] ?? "";
            const allowlisted = config.auth.allowedDomains.includes(domain);
            return {data: {...user, role: first ? "admin" : "user", status: first || allowlisted ? "active" : "pending"}};
          },
          after: async (user) => {
            if (user.status === "pending" && config.mail.adminNotify) {
              await sendMail(env, config, {to: config.mail.adminNotify, subject: `${config.brand.title}: new account waiting for approval`,
                text: `${user.email} signed up and is waiting for approval.\n\n${env.BASE_URL}/_door/admin`});
            }
          }
        }
      }
    },
    plugins: [
      admin({defaultRole: "user", adminRoles: ["admin"]}),
      magicLink({
        sendMagicLink: async ({email, url}) => {
          await sendMail(env, config, {to: email, subject: `Sign in to ${config.brand.title}`, text: `Click to sign in:\n\n${url}\n\nThis link expires in 5 minutes.`});
        }
      })
    ]
  });
}
```

- [ ] **Step 6: Implement session.js**

```js
// src/session.js
export class SessionUnavailable extends Error {
  constructor(cause) { super("session storage unavailable"); this.cause = cause; }
}

/** Returns {user, session} or null. Any storage failure throws SessionUnavailable so the caller fails closed. */
export async function readSession(auth, request) {
  if (!request.headers.get("cookie")) return null;
  try {
    return await auth.api.getSession({headers: request.headers});
  } catch (err) {
    throw new SessionUnavailable(err);
  }
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/auth.test.js`
Expected: pass. Common failures and what they mean:
- `no such column: status` → migration column naming; fix `migrations/0001_auth.sql`.
- Better Auth complains about `baseURL` → set `BASE_URL` binding in `vitest.config.js` (Task 1 Step 5 does).
- The "fails closed" test passes without throwing → `getSession` swallowed the error and returned null; in that case make `readSession` do a cheap `db` probe first: `await env.DB.prepare("select 1").first()` inside the try. Keep the test.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/auth.js src/session.js src/mail.js test/auth.test.js && git commit -m "auth: Better Auth on D1 with status field, first-user admin, allowlisted domains, fail-closed session reader"
```

---

### Task 6: Worker routing and the gate end to end

**Files:**
- Modify: `src/index.js` (replace placeholder)
- Test: `test/routes.test.js`; extend `test/helpers.js`
- Delete: `test/smoke.test.js`

**Interfaces:**
- Consumes: `compileRules`, `decide`, `isNavigation`, `serveFromR2`, `createAuth`, `readSession`, `loadConfig`.
- Produces: the Hono `app` and default export `{fetch}`. Hono context variables: `c.get("auth")`, `c.get("config")`, `c.get("session")` (null or `{user, session}`), set by middleware for `/_door/*` and gated routes.
- Produces (helper): `signUp(email)` and `signIn(email)` that hit the Worker via `exports.default.fetch` and return the cookie string; `approve(email)` that flips status in D1 directly.

- [ ] **Step 1: Extend helpers**

```js
// test/helpers.js (append)
import {env, exports} from "cloudflare:workers";
const PASSWORD = "correct horse battery";
async function authPost(path, body) {
  return exports.default.fetch("http://example.com/auth/" + path, {
    method: "POST", headers: {"content-type": "application/json", origin: "http://example.com"}, body: JSON.stringify(body)
  });
}
export async function signUp(email) {
  const res = await authPost("sign-up/email", {email, password: PASSWORD, name: email});
  if (res.status !== 200) throw new Error(`sign-up ${res.status}: ${await res.text()}`);
  return res.headers.get("set-cookie").split(";")[0];
}
export async function signIn(email) {
  const res = await authPost("sign-in/email", {email, password: PASSWORD});
  if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${await res.text()}`);
  return res.headers.get("set-cookie").split(";")[0];
}
export async function setStatus(email, status) {
  await env.DB.prepare("update user set status = ? where email = ?").bind(status, email).run();
}
export const get = (path, headers = {}) => exports.default.fetch("http://example.com" + path, {headers});
export const NAV = {accept: "text/html,application/xhtml+xml"};
```

- [ ] **Step 2: Write the failing tests**

```js
// test/routes.test.js
import {env} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, setStatus, get, NAV} from "./helpers.js";

beforeAll(() => putSite(env, {
  "index.html": "<h1>home</h1>", "about.html": "<h1>about</h1>", "ntd.html": "<h1>ntd</h1>", "404.html": "nope",
  "_file/data/x.abc.parquet": new Uint8Array(10), "_observablehq/client.js": "js"
}));
// doorman.config.js in the repo has pages: [] — the tests below inject rules through
// the TEST_PAGES binding, which src/index.js honours only when defined (see Step 4).

describe("routing", () => {
  it("anonymous navigation to a protected page redirects to login with next", async () => {
    const res = await get("/coverage", NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_door/login?next=%2Fcoverage");
  });
  it("anonymous data fetch gets 401, not a redirect", async () => {
    const res = await get("/_file/data/x.abc.parquet");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
  it("public page and runtime chunk serve anonymously; data stays protected", async () => {
    expect((await get("/about", NAV)).status).toBe(200);
    expect((await get("/_observablehq/client.js")).status).toBe(200);
    expect((await get("/_file/data/x.abc.parquet")).status).toBe(401);
  });
  it("disabled page is 404 even for an active user", async () => {
    const cookie = await signUp("first@example.org"); // first user → admin, active
    expect((await get("/ntd", {...NAV, cookie})).status).toBe(404);
    expect((await get("/ntd", NAV)).status).toBe(404);
  });
  it("pending user is sent to /_door/pending; approved user gets the page and the data", async () => {
    const cookie = await signUp("p@example.org");
    let res = await get("/", {...NAV, cookie});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_door/pending");
    expect((await get("/_file/data/x.abc.parquet", {cookie})).status).toBe(403);
    await setStatus("p@example.org", "active");
    res = await get("/", {...NAV, cookie});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    res = await get("/_file/data/x.abc.parquet", {cookie, range: "bytes=0-3"});
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-3/10");
  });
  it("/auth/* is reachable without a session", async () => {
    const res = await get("/auth/get-session");
    expect(res.status).toBe(200);
  });
  it("non-GET to site paths is 405", async () => {
    const res = await exports.default.fetch("http://example.com/about", {method: "POST"});
    expect(res.status).toBe(405);
  });
});
```

Add to `vitest.config.js` miniflare bindings:

```js
TEST_PAGES: JSON.stringify([{match: "about", access: "public"}, {match: "ntd", access: "disabled"}])
```

- [ ] **Step 3: Run to verify failure** → FAIL (placeholder Worker returns 200 for everything).

- [ ] **Step 4: Implement src/index.js**

```js
// src/index.js
import {Hono} from "hono";
import {loadConfig} from "./config.js";
import {compileRules} from "./rules.js";
import {decide, isNavigation} from "./gate.js";
import {serveFromR2} from "./serve.js";
import {createAuth} from "./auth.js";
import {readSession, SessionUnavailable} from "./session.js";
import {doorPages} from "./pages/index.js";

const baseConfig = loadConfig();

function configFor(env) {
  // Tests inject page rules; production uses doorman.config.js as-is.
  if (env.TEST_PAGES) return {...baseConfig, pages: JSON.parse(env.TEST_PAGES)};
  return baseConfig;
}

export const app = new Hono();

app.use("*", async (c, next) => {
  const config = configFor(c.env);
  c.set("config", config);
  c.set("auth", createAuth(c.env, config));
  c.set("resolveAccess", compileRules(config.pages));
  await next();
});

app.all("/auth/*", (c) => c.get("auth").handler(c.req.raw));

app.use("/_door/*", async (c, next) => {
  try {
    c.set("session", await readSession(c.get("auth"), c.req.raw));
  } catch (err) {
    if (err instanceof SessionUnavailable) return c.text("Service unavailable", 503);
    throw err;
  }
  await next();
});
app.route("/_door", doorPages);

app.all("*", async (c) => {
  const request = c.req.raw;
  if (request.method !== "GET" && request.method !== "HEAD") return c.text("Method not allowed", 405);
  const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
  const access = c.get("resolveAccess")(path);
  let user = null;
  if (access === "protected") {
    try {
      user = (await readSession(c.get("auth"), request))?.user ?? null;
    } catch (err) {
      if (err instanceof SessionUnavailable) return c.text("Service unavailable", 503);
      throw err;
    }
  }
  const d = decide({access, user, isNavigation: isNavigation(request), path});
  const config = c.get("config");
  switch (d.kind) {
    case "redirect": return c.redirect(d.to, 302);
    case "status": return new Response(null, {status: d.status, headers: {"cache-control": "no-store"}});
    case "notfound": {
      const nf = await c.env.SITE.get(`_site/${config.site.name}/404.html`);
      return new Response(nf ? nf.body : "Not found", {status: 404, headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
    }
    default: return serveFromR2(c.env.SITE, `_site/${config.site.name}/`, request, path, access);
  }
});

export default {fetch: app.fetch};
```

Create a stub `src/pages/index.js` so the import resolves; Task 7 fills it:

```js
// src/pages/index.js
import {Hono} from "hono";
export const doorPages = new Hono();
doorPages.all("*", (c) => c.text("Not found", 404));
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: rules, gate, serve, auth, routes all pass. Delete `test/smoke.test.js`.

- [ ] **Step 6: Commit**

```bash
git rm -q test/smoke.test.js
git add -A && git commit -m "worker: route order, gate middleware, fail-closed 503, disabled 404, test page rules"
```

---

### Task 7: Login, signup, pending, sign-out pages

**Files:**
- Create: `src/pages/layout.js`, `src/pages/style.js`, `src/pages/login.js`, `src/pages/signup.js`, `src/pages/pending.js`
- Modify: `src/pages/index.js`
- Test: `test/pages.test.js`

**Interfaces:**
- Consumes: `c.get("auth")`, `c.get("config")`, `c.get("session")` from Task 6.
- Produces: `page({config, title, body, message, error}) → string` in `layout.js`. `escape(s)` HTML escaper. Routes on `doorPages`:
  - `GET /_door/login?next=`, `POST /_door/login` (fields `email`, `password`, `next`)
  - `POST /_door/magic` (fields `email`, `next`)
  - `GET /_door/signup`, `POST /_door/signup` (fields `email`, `password`, `name`)
  - `GET /_door/pending`, `POST /_door/signout`
- Helper `forwardCookies(from: Headers, to: Response)` copies every `set-cookie` header.
- `safeNext(next)` returns `next` only if it starts with a single `/`, else `/`.

- [ ] **Step 1: Write the failing tests**

```js
// test/pages.test.js
import {env, exports} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, setStatus, get, NAV} from "./helpers.js";

const form = (path, fields, headers = {}) => exports.default.fetch("http://example.com" + path, {
  method: "POST", headers: {"content-type": "application/x-www-form-urlencoded", origin: "http://example.com", ...headers},
  body: new URLSearchParams(fields).toString(), redirect: "manual"
});

beforeAll(() => putSite(env, {"index.html": "<h1>home</h1>"}));

describe("login page", () => {
  it("renders with brand title and the next field", async () => {
    const res = await get("/_door/login?next=%2Fcoverage", NAV);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Campaign Dashboards");
    expect(html).toContain('name="next" value="/coverage"');
    expect(html).toContain('action="/_door/magic"');
  });
  it("wrong password re-renders with an error, no cookie", async () => {
    await signUp("a@example.org");
    const res = await form("/_door/login", {email: "a@example.org", password: "nope nope nope", next: "/"});
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Invalid email or password/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("correct password sets the cookie and redirects to next", async () => {
    await signUp("b@example.org");
    const res = await form("/_door/login", {email: "b@example.org", password: "correct horse battery", next: "/coverage"});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/coverage");
    expect(res.headers.get("set-cookie")).toMatch(/better-auth\.session_token=/);
  });
  it("refuses an off-site next", async () => {
    await signUp("c@example.org");
    const res = await form("/_door/login", {email: "c@example.org", password: "correct horse battery", next: "https://evil.example/x"});
    expect(res.headers.get("location")).toBe("/");
  });
  it("magic link form answers with a 'check your email' page and logs the link", async () => {
    await signUp("m@example.org");
    const res = await form("/_door/magic", {email: "m@example.org", next: "/"});
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Check your email/);
  });
  it("signed-in active user visiting login is sent to next", async () => {
    const cookie = await signUp("d@example.org"); await setStatus("d@example.org", "active");
    const res = await get("/_door/login?next=%2Fabout", {...NAV, cookie});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/about");
  });
});

describe("signup and pending", () => {
  it("signup creates a pending user and redirects to /_door/pending", async () => {
    await signUp("zeroth@example.org"); // make sure the first-admin slot is taken
    const res = await form("/_door/signup", {email: "new@example.org", password: "correct horse battery", name: "New"});
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/_door/pending");
    const row = await env.DB.prepare("select status from user where email = ?").bind("new@example.org").first();
    expect(row.status).toBe("pending");
  });
  it("duplicate signup re-renders with an error", async () => {
    await signUp("dup@example.org");
    const res = await form("/_door/signup", {email: "dup@example.org", password: "correct horse battery", name: "Dup"});
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/already/i);
  });
  it("pending page shows waiting text and sign-out works", async () => {
    const cookie = await signUp("w@example.org");
    const res = await get("/_door/pending", {...NAV, cookie});
    expect(await res.text()).toMatch(/waiting for approval/);
    const out = await form("/_door/signout", {}, {cookie});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/_door/login");
    expect(out.headers.get("set-cookie")).toMatch(/session_token=;|Max-Age=0/);
  });
  it("unknown /_door path is 404", async () => {
    expect((await get("/_door/whatever")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (stub returns 404 everywhere).

- [ ] **Step 3: layout.js and style.js**

```js
// src/pages/style.js
export const STYLE = `
:root{--accent:#0b57d0;--fg:#1a1a1a;--bg:#f7f7f7;--card:#fff;--muted:#666;--err:#b3261e}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:420px;margin:8vh auto;padding:0 16px}main.wide{max-width:960px}
.card{background:var(--card);border:1px solid #e3e3e3;border-radius:8px;padding:24px}
h1{font-size:20px;margin:0 0 16px}label{display:block;margin:12px 0 4px;color:var(--muted);font-size:13px}
input[type=email],input[type=password],input[type=text]{width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font:inherit}
button{margin-top:16px;padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button.quiet{background:transparent;color:var(--accent);padding:6px 0}
.msg{padding:10px 12px;border-radius:6px;margin-bottom:12px;background:#eef3ff}.msg.err{background:#fde8e6;color:var(--err)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #eee;vertical-align:top}
td form{display:inline}td button{margin:0 4px 0 0;padding:4px 8px;font-size:13px}.muted{color:var(--muted)}
`;
```

```js
// src/pages/layout.js
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
```

- [ ] **Step 4: login.js**

```js
// src/pages/login.js
import {Hono} from "hono";
import {APIError} from "better-auth/api";
import {page, html, escape, safeNext, withCookies} from "./layout.js";

export const login = new Hono();

function loginForm({config, next, email = "", message, error}) {
  const body = `
<form method="post" action="/_door/login">
  <input type="hidden" name="next" value="${escape(next)}">
  <label for="email">Email</label><input id="email" type="email" name="email" value="${escape(email)}" required autofocus>
  <label for="password">Password</label><input id="password" type="password" name="password" required>
  <button type="submit">Sign in</button>
</form>
<form method="post" action="/_door/magic" style="margin-top:12px">
  <input type="hidden" name="next" value="${escape(next)}"><input type="hidden" name="email" value="${escape(email)}">
  <button type="submit" class="quiet" onclick="this.form.email.value=document.getElementById('email').value">Email me a sign-in link instead</button>
</form>
<p class="muted">No account? <a href="/_door/signup">Sign up</a></p>`;
  return page({config, title: "Sign in", body, message, error});
}

login.get("/login", (c) => {
  const next = safeNext(c.req.query("next"));
  const s = c.get("session");
  if (s?.user?.status === "active") return c.redirect(next, 302);
  if (s?.user) return c.redirect("/_door/pending", 302);
  return html(c, loginForm({config: c.get("config"), next}));
});

login.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  try {
    const {headers} = await c.get("auth").api.signInEmail({
      body: {email, password: String(form.password || "")}, headers: c.req.raw.headers, returnHeaders: true
    });
    return withCookies(c.redirect(next, 302), headers);
  } catch (err) {
    if (err instanceof APIError) return html(c, loginForm({config: c.get("config"), next, email, error: "Invalid email or password."}));
    throw err;
  }
});

login.post("/magic", async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const email = String(form.email || "").trim().toLowerCase();
  const config = c.get("config");
  if (!email) return html(c, loginForm({config, next, error: "Enter your email first."}));
  try {
    await c.get("auth").api.signInMagicLink({body: {email, callbackURL: next}, headers: c.req.raw.headers});
  } catch (err) {
    if (!(err instanceof APIError)) throw err; // unknown email etc. → same message, no enumeration
  }
  return html(c, page({config, title: "Check your email", body: `<p>If <strong>${escape(email)}</strong> has an account, a sign-in link is on its way. It expires in 5 minutes.</p><p><a href="/_door/login">Back</a></p>`}));
});
```

- [ ] **Step 5: signup.js and pending.js**

```js
// src/pages/signup.js
import {Hono} from "hono";
import {APIError} from "better-auth/api";
import {page, html, escape, withCookies} from "./layout.js";

export const signup = new Hono();

function signupForm({config, email = "", name = "", error}) {
  const body = `
<form method="post" action="/_door/signup">
  <label for="name">Name</label><input id="name" type="text" name="name" value="${escape(name)}" required>
  <label for="email">Email</label><input id="email" type="email" name="email" value="${escape(email)}" required>
  <label for="password">Password <span class="muted">(10+ characters)</span></label><input id="password" type="password" name="password" minlength="10" required>
  <button type="submit">Create account</button>
</form>
<p class="muted">New accounts need approval by an administrator before they can see anything.</p>
<p class="muted"><a href="/_door/login">Back to sign in</a></p>`;
  return page({config, title: "Sign up", body, error});
}

signup.get("/signup", (c) => html(c, signupForm({config: c.get("config")})));

signup.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email || "").trim().toLowerCase();
  const name = String(form.name || "").trim() || email;
  const config = c.get("config");
  try {
    const {headers} = await c.get("auth").api.signUpEmail({
      body: {email, name, password: String(form.password || "")}, headers: c.req.raw.headers, returnHeaders: true
    });
    return withCookies(c.redirect("/_door/pending", 302), headers);
  } catch (err) {
    if (err instanceof APIError) {
      const msg = /exist/i.test(err.message) ? "An account with that email already exists. Try signing in." : err.message;
      return html(c, signupForm({config, email, name, error: msg}));
    }
    throw err;
  }
});
```

```js
// src/pages/pending.js
import {Hono} from "hono";
import {page, html, withCookies} from "./layout.js";

export const pending = new Hono();

pending.get("/pending", (c) => {
  const s = c.get("session");
  const config = c.get("config");
  if (!s?.user) return c.redirect("/_door/login", 302);
  if (s.user.status === "active") return c.redirect("/", 302);
  const text = s.user.status === "disabled"
    ? "Your account has been disabled. Contact the administrator if you think this is a mistake."
    : "Your account is waiting for approval. You will get an email when it is approved.";
  const body = `<p>${text}</p><form method="post" action="/_door/signout"><button type="submit" class="quiet">Sign out</button></form>`;
  return html(c, page({config, title: "Almost there", body}));
});

pending.post("/signout", async (c) => {
  const {headers} = await c.get("auth").api.signOut({headers: c.req.raw.headers, returnHeaders: true});
  return withCookies(c.redirect("/_door/login", 302), headers);
});
```

- [ ] **Step 6: Wire pages/index.js**

```js
// src/pages/index.js
import {Hono} from "hono";
import {login} from "./login.js";
import {signup} from "./signup.js";
import {pending} from "./pending.js";

export const doorPages = new Hono();
doorPages.route("/", login);
doorPages.route("/", signup);
doorPages.route("/", pending);
doorPages.all("*", (c) => c.text("Not found", 404));
```

- [ ] **Step 7: Run tests**

Run: `npm test`
Expected: pass. Watch for:
- `returnHeaders` missing → older Better Auth; upgrade to ≥1.7 (Task 1 pins ^1.7.4).
- Sign-out with no session throws → wrap in try/catch and still redirect.
- `signInMagicLink` for an unknown email: Better Auth may create the user by default. Check the plugin option `disableSignUp: true` and set it, since accounts must come from `/_door/signup` so the `status` hook runs. Add that option to `magicLink({...})` in `src/auth.js` and a test in `test/auth.test.js` that a magic link for an unknown email creates no user row.

- [ ] **Step 8: Commit**

```bash
git add src/pages test/pages.test.js test/auth.test.js src/auth.js && git commit -m "pages: login, magic link, signup, pending, sign-out rendered by the worker"
```

---

### Task 8: Admin page and actions

**Files:**
- Create: `src/users.js`, `src/pages/csrf.js`, `src/pages/admin.js`
- Modify: `src/pages/index.js`
- Test: `test/admin.test.js`

**Interfaces:**
- Produces (`users.js`): `listUsers(db) → Array<{id, email, name, role, status, createdAt, lastSignIn}>` (lastSignIn = max `session.createdAt`), `setStatus(db, userId, status)`, `countAdmins(db)`. All take a Kysely `db`; expose `dbFor(env)` that builds one.
- Produces (`csrf.js`): `csrfToken(secret, sessionToken) → string` (HMAC-SHA256 hex, first 32 chars) and `checkCsrf(secret, sessionToken, submitted) → boolean` (constant-time compare).
- Routes: `GET /_door/admin`; `POST /_door/admin/approve|disable|enable|make-admin|remove-admin|delete` with fields `userId`, `csrf`. All require `session.user.role === "admin"` and `status === "active"`, else 404.
- On approve, send "your account was approved" mail to the user.

- [ ] **Step 1: Write the failing tests**

```js
// test/admin.test.js
import {env, exports} from "cloudflare:workers";
import {beforeAll, describe, it, expect} from "vitest";
import {putSite, signUp, get, NAV} from "./helpers.js";

const post = (action, fields, cookie) => exports.default.fetch("http://example.com/_door/admin/" + action, {
  method: "POST", headers: {"content-type": "application/x-www-form-urlencoded", origin: "http://example.com", cookie},
  body: new URLSearchParams(fields).toString(), redirect: "manual"
});
const idOf = async (email) => (await env.DB.prepare("select id from user where email = ?").bind(email).first()).id;
const statusOf = async (email) => (await env.DB.prepare("select status, role from user where email = ?").bind(email).first());
async function tokenFor(cookie) {
  const html = await (await get("/_door/admin", {...NAV, cookie})).text();
  return html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
}

let adminCookie, userCookie;
beforeAll(async () => {
  await putSite(env, {"index.html": "home"});
  adminCookie = await signUp("admin@example.org");
  userCookie = await signUp("user@example.org");
});

describe("admin page", () => {
  it("is 404 for anonymous and for non-admins", async () => {
    expect((await get("/_door/admin", NAV)).status).toBe(404);
    expect((await get("/_door/admin", {...NAV, cookie: userCookie})).status).toBe(404);
  });
  it("lists users with status and a csrf token for admins", async () => {
    const res = await get("/_door/admin", {...NAV, cookie: adminCookie});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user@example.org");
    expect(html).toMatch(/name="csrf" value="[a-f0-9]{32}"/);
    expect(html).toContain('action="/_door/admin/approve"');
  });
  it("approve flips status and rejects a bad csrf", async () => {
    const userId = await idOf("user@example.org");
    let res = await post("approve", {userId, csrf: "deadbeef"}, adminCookie);
    expect(res.status).toBe(403);
    expect((await statusOf("user@example.org")).status).toBe("pending");
    res = await post("approve", {userId, csrf: await tokenFor(adminCookie)}, adminCookie);
    expect(res.status).toBe(302);
    expect((await statusOf("user@example.org")).status).toBe("active");
  });
  it("disable, enable, make-admin, remove-admin, delete", async () => {
    const userId = await idOf("user@example.org");
    const csrf = await tokenFor(adminCookie);
    await post("disable", {userId, csrf}, adminCookie);
    expect((await statusOf("user@example.org")).status).toBe("disabled");
    await post("enable", {userId, csrf}, adminCookie);
    expect((await statusOf("user@example.org")).status).toBe("active");
    await post("make-admin", {userId, csrf}, adminCookie);
    expect((await statusOf("user@example.org")).role).toBe("admin");
    await post("remove-admin", {userId, csrf}, adminCookie);
    expect((await statusOf("user@example.org")).role).toBe("user");
    await post("delete", {userId, csrf}, adminCookie);
    expect(await statusOf("user@example.org")).toBeNull();
  });
  it("an admin cannot disable, demote, or delete themself", async () => {
    const me = await idOf("admin@example.org");
    const csrf = await tokenFor(adminCookie);
    for (const action of ["disable", "remove-admin", "delete"]) {
      const res = await post(action, {userId: me, csrf}, adminCookie);
      expect(res.status).toBe(400);
    }
    expect((await statusOf("admin@example.org")).status).toBe("active");
  });
  it("non-admin POSTs are 404", async () => {
    const res = await post("approve", {userId: "x", csrf: "y"}, userCookie);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL, all 404.

- [ ] **Step 3: users.js**

```js
// src/users.js
import {Kysely} from "kysely";
import {D1Dialect} from "kysely-d1";

export const dbFor = (env) => new Kysely({dialect: new D1Dialect({database: env.DB})});

export async function listUsers(db) {
  return db.selectFrom("user")
    .leftJoin("session", "session.userId", "user.id")
    .select(["user.id", "user.email", "user.name", "user.role", "user.status", "user.createdAt",
      (eb) => eb.fn.max("session.createdAt").as("lastSignIn")])
    .groupBy("user.id").orderBy("user.createdAt", "desc").execute();
}

export async function setStatus(db, userId, status) {
  await db.updateTable("user").set({status, updatedAt: new Date()}).where("id", "=", userId).execute();
}

export async function getUser(db, userId) {
  return db.selectFrom("user").selectAll().where("id", "=", userId).executeTakeFirst();
}
```

- [ ] **Step 4: csrf.js**

```js
// src/pages/csrf.js
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function csrfToken(secret, sessionToken) {
  return (await hmac(secret, "csrf:" + sessionToken)).slice(0, 32);
}
export async function checkCsrf(secret, sessionToken, submitted) {
  const expected = await csrfToken(secret, sessionToken);
  if (typeof submitted !== "string" || submitted.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ submitted.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 5: admin.js**

```js
// src/pages/admin.js
import {Hono} from "hono";
import {page, html, escape} from "./layout.js";
import {csrfToken, checkCsrf} from "./csrf.js";
import {dbFor, listUsers, setStatus, getUser} from "../users.js";
import {sendMail} from "../mail.js";

export const admin = new Hono();

admin.use("/admin/*", async (c, next) => { await requireAdmin(c, next); });
admin.use("/admin", async (c, next) => { await requireAdmin(c, next); });
async function requireAdmin(c, next) {
  const s = c.get("session");
  if (!s?.user || s.user.role !== "admin" || s.user.status !== "active") return c.text("Not found", 404);
  await next();
}

const fmt = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";

admin.get("/admin", async (c) => {
  const config = c.get("config");
  const s = c.get("session");
  const csrf = await csrfToken(c.env.BETTER_AUTH_SECRET, s.session.token);
  const users = await listUsers(dbFor(c.env));
  const btn = (action, userId, label) => `<form method="post" action="/_door/admin/${action}"><input type="hidden" name="userId" value="${escape(userId)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${label}</button></form>`;
  const rows = users.map((u) => {
    const self = u.id === s.user.id;
    const actions = [
      u.status !== "active" ? btn(u.status === "pending" ? "approve" : "enable", u.id, u.status === "pending" ? "Approve" : "Enable") : (!self ? btn("disable", u.id, "Disable") : ""),
      u.role === "admin" ? (!self ? btn("remove-admin", u.id, "Remove admin") : "") : btn("make-admin", u.id, "Make admin"),
      !self ? btn("delete", u.id, "Delete") : ""
    ].join("");
    return `<tr><td>${escape(u.email)}<br><span class="muted">${escape(u.name)}</span></td><td>${escape(u.status)}</td><td>${escape(u.role)}</td><td>${fmt(u.createdAt)}</td><td>${fmt(u.lastSignIn)}</td><td>${actions}</td></tr>`;
  }).join("");
  const body = `<table><thead><tr><th>User</th><th>Status</th><th>Role</th><th>Created</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Signed in as ${escape(s.user.email)} · <a href="/">Site</a></p><form method="post" action="/_door/signout"><button class="quiet">Sign out</button></form>`;
  return html(c, page({config, title: "Users", body, wide: true, message: c.req.query("ok") ? "Done." : null}));
});

const ACTIONS = {
  approve: {status: "active", notify: true}, enable: {status: "active"}, disable: {status: "disabled", notSelf: true},
  "make-admin": {role: "admin"}, "remove-admin": {role: "user", notSelf: true}, delete: {remove: true, notSelf: true}
};

admin.post("/admin/:action", async (c) => {
  const spec = ACTIONS[c.req.param("action")];
  if (!spec) return c.text("Not found", 404);
  const s = c.get("session");
  const form = await c.req.parseBody();
  if (!(await checkCsrf(c.env.BETTER_AUTH_SECRET, s.session.token, form.csrf))) return c.text("Bad token", 403);
  const userId = String(form.userId || "");
  if (spec.notSelf && userId === s.user.id) return c.text("You cannot do that to your own account", 400);
  const db = dbFor(c.env);
  const target = await getUser(db, userId);
  if (!target) return c.text("No such user", 404);
  const auth = c.get("auth");
  if (spec.remove) await auth.api.removeUser({body: {userId}, headers: c.req.raw.headers});
  if (spec.role) await auth.api.setRole({body: {userId, role: spec.role}, headers: c.req.raw.headers});
  if (spec.status) await setStatus(db, userId, spec.status);
  if (spec.notify && target.status !== "active") {
    const config = c.get("config");
    await sendMail(c.env, config, {to: target.email, subject: `${config.brand.title}: your account is approved`, text: `You can sign in now:\n\n${c.env.BASE_URL}/`});
  }
  return c.redirect("/_door/admin?ok=1", 302);
});
```

Add `doorPages.route("/", admin);` in `src/pages/index.js` before the 404 catch-all.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: pass. Notes:
- If `setRole`/`removeUser` reject with "unauthorized", the admin plugin checks `adminRoles` against `session.user.role`; confirm the role column is populated (Task 5 hook sets it) and that the session passed via `headers` is the admin's.
- Better Auth's `removeUser` cascades sessions/accounts through the adapter; the FK `ON DELETE CASCADE` covers D1 either way.

- [ ] **Step 7: Commit**

```bash
git add src/users.js src/pages/csrf.js src/pages/admin.js src/pages/index.js test/admin.test.js && git commit -m "admin: user table with approve/disable/role/delete actions and HMAC csrf"
```

---

### Task 9: Resend mail sender

**Files:**
- Modify: `src/mail.js`
- Test: `test/mail.test.js`

**Interfaces:**
- `sendMail(env, config, {to, subject, text})` posts to `https://api.resend.com/emails` with bearer `env.RESEND_API_KEY`, body `{from: config.mail.from, to: [to], subject, text}`. Non-2xx → logs and throws `MailError`. Callers that must not fail (sign-up hook, approve action) catch `MailError` and continue.
- Adds an injectable `fetch` for tests: `sendMail(env, config, msg, {fetch})`.

- [ ] **Step 1: Write the failing tests**

```js
// test/mail.test.js
import {describe, it, expect, vi} from "vitest";
import {sendMail, MailError} from "../src/mail.js";

const config = {mail: {from: "doorman@example.org"}, brand: {title: "T"}};

describe("sendMail", () => {
  it("logs to console without an API key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendMail({}, config, {to: "a@b", subject: "S", text: "hello"});
    expect(log.mock.calls[0][0]).toContain("hello");
    log.mockRestore();
  });
  it("posts to Resend with the key", async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({url, init}); return new Response("{}", {status: 200}); };
    await sendMail({RESEND_API_KEY: "re_x"}, config, {to: "a@b", subject: "S", text: "hi"}, {fetch});
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.headers.authorization).toBe("Bearer re_x");
    expect(JSON.parse(calls[0].init.body)).toEqual({from: "doorman@example.org", to: ["a@b"], subject: "S", text: "hi"});
  });
  it("throws MailError on non-2xx", async () => {
    const fetch = async () => new Response("nope", {status: 422});
    await expect(sendMail({RESEND_API_KEY: "re_x"}, config, {to: "a@b", subject: "S", text: "hi"}, {fetch})).rejects.toBeInstanceOf(MailError);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (`MailError` not exported, Resend path throws "not implemented").

- [ ] **Step 3: Implement**

```js
// src/mail.js
export class MailError extends Error {}

export async function sendMail(env, config, {to, subject, text}, {fetch: doFetch = globalThis.fetch} = {}) {
  if (!env.RESEND_API_KEY) {
    console.log(`[doorman mail] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return;
  }
  const res = await doFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json"},
    body: JSON.stringify({from: config.mail.from, to: [to], subject, text})
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[doorman mail] resend ${res.status}: ${detail}`);
    throw new MailError(`resend ${res.status}`);
  }
}
```

Then make the two non-critical callers tolerant. In `src/auth.js` `after` hook and in `src/pages/admin.js` approve action, wrap the `sendMail` call:

```js
try { await sendMail(...); } catch (err) { if (!(err instanceof MailError)) throw err; }
```

(import `MailError` from `./mail.js` / `../mail.js`). The magic-link sender stays strict: if the mail can't go out, Better Auth returns an error and the page shows the same "check your email" text, which is acceptable, but log it.

- [ ] **Step 4: Run tests** → pass.

- [ ] **Step 5: Commit**

```bash
git add src/mail.js src/auth.js src/pages/admin.js test/mail.test.js && git commit -m "mail: Resend sender with console fallback; notifications never break sign-up or approval"
```

---

### Task 10: Rate limiting and D1-down behaviour

**Files:**
- Test: `test/ratelimit.test.js`
- Modify: `src/auth.js` only if the test shows the limiter is off in the test environment.

**Interfaces:** none new. Verifies the `rateLimit` config from Task 5 and the 503 path from Task 6 under real requests.

- [ ] **Step 1: Write the tests**

```js
// test/ratelimit.test.js
import {env, exports} from "cloudflare:workers";
import {describe, it, expect} from "vitest";
import {signUp, get, NAV} from "./helpers.js";

describe("rate limit", () => {
  it("blocks the 11th password attempt in a minute", async () => {
    await signUp("rl@example.org");
    let last;
    for (let i = 0; i < 11; i++) {
      last = await exports.default.fetch("http://example.com/auth/sign-in/email", {
        method: "POST", headers: {"content-type": "application/json", origin: "http://example.com", "x-forwarded-for": "203.0.113.9"},
        body: JSON.stringify({email: "rl@example.org", password: "wrong wrong wrong"})
      });
    }
    expect(last.status).toBe(429);
  });
});

describe("D1 down", () => {
  it("protected navigation is 503, never served", async () => {
    // Break the DB by dropping the session table for this test file's isolated storage.
    await env.DB.prepare("drop table session").run();
    const res = await get("/", {...NAV, cookie: "better-auth.session_token=abc"});
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/ratelimit.test.js`
If the rate-limit test gets 200/401 for all 11: Better Auth disables rate limiting when `NODE_ENV` is not `production`. Force it: in `src/auth.js` keep `rateLimit.enabled: true` (explicit `true` overrides the env check per docs). If it still doesn't limit, check that the `rateLimit` table exists (migration) and that the client IP header is read: set `advanced: {ipAddress: {ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"]}}` in the Better Auth options.

If the D1-down test gets 200: `getSession` returned null on error instead of throwing. Apply the probe noted in Task 5 Step 7: in `readSession`, run `await auth.options?.database?.db?.selectFrom("session").select("id").limit(1).execute()` inside the try before `getSession`, or, simpler, have `createAuth` also return the `db` (`return Object.assign(auth, {db})`) and probe `auth.db`.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "tests: rate limit on sign-in and fail-closed 503 when D1 is unavailable"
```

---

### Task 11: Deploy script, rule checker, README

**Files:**
- Create: `deploy.sh`, `scripts/check-rules.js`, `README.md` (full), `.dev.vars.example`
- Modify: `wrangler.jsonc` (production routes section documented, left commented)

**Interfaces:**
- `deploy.sh [--skip-build] [--dry-run]`: reads `doorman.config.js` for `site.name` and `site.dist`, runs the site build in `site.dist/..` (`npm run build`), `rclone sync` to `r2:<bucket>/_site/<name>/`, `wrangler d1 migrations apply doorman --remote`, `wrangler deploy`.
- `scripts/check-rules.js`: loads config, compiles rules, walks `site.dist`, prints each `.html` that resolves `public` and warns when no `_file/` object resolves `public`. Exit 0 always; it is advisory.

- [ ] **Step 1: deploy.sh**

```bash
#!/usr/bin/env bash
# Build the site, publish it to R2, migrate D1, deploy the Worker.
#   ./deploy.sh [--skip-build] [--dry-run]
# Env: R2_BUCKET (default: bucket_name from wrangler.jsonc), R2_REMOTE (rclone remote, default r2)
set -euo pipefail
cd "$(dirname "$0")"
BUILD=1; DRY=""
for a in "$@"; do case "$a" in --skip-build) BUILD=0;; --dry-run) DRY="--dry-run";; *) echo "unknown option $a" >&2; exit 2;; esac; done

NAME=$(node -e 'import("./doorman.config.js").then(m=>console.log(m.default.site.name))')
DIST=$(node -e 'import("./doorman.config.js").then(m=>console.log(m.default.site.dist||""))')
BUCKET="${R2_BUCKET:-$(node -e 'const c=JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8").replace(/\/\/.*$/mg,""));console.log(c.r2_buckets[0].bucket_name)')}"
REMOTE="${R2_REMOTE:-r2}"
[ -n "$DIST" ] || { echo "doorman.config.js: site.dist is required to deploy" >&2; exit 1; }

if [ "$BUILD" = 1 ]; then echo "== build site in $DIST/.."; (cd "$DIST/.." && npm run build); fi
echo "== check page rules"; node scripts/check-rules.js || true
echo "== sync $DIST → $REMOTE:$BUCKET/_site/$NAME ${DRY:+(dry run)}"
rclone sync $DRY --checksum --fast-list --transfers 16 --exclude ".DS_Store" "$DIST" "$REMOTE:$BUCKET/_site/$NAME" --stats-one-line -v 2>&1 | tail -3
if [ -z "$DRY" ]; then
  echo "== migrate D1"; npx wrangler d1 migrations apply doorman --remote
  echo "== deploy worker"; npx wrangler deploy
fi
```

`chmod +x deploy.sh`.

- [ ] **Step 2: scripts/check-rules.js**

```js
// Advisory: list public pages and warn if none of the data files are public.
import {readdirSync, statSync} from "node:fs";
import {join, relative} from "node:path";
import {compileRules} from "../src/rules.js";
import config from "../doorman.config.js";

const dist = config.site.dist;
if (!dist) { console.log("check-rules: site.dist not set, skipping"); process.exit(0); }
const resolve = compileRules(config.pages ?? []);
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative(dist, p)); } })(dist);
const publicPages = files.filter((f) => f.endsWith(".html") && resolve(f) === "public");
const publicData = files.filter((f) => f.startsWith("_file/") && resolve(f) === "public");
const disabled = files.filter((f) => f.endsWith(".html") && resolve(f) === "disabled");
console.log(`public pages: ${publicPages.length ? publicPages.join(", ") : "none"}`);
console.log(`disabled pages: ${disabled.length ? disabled.join(", ") : "none"}`);
if (publicPages.length && !publicData.length) console.warn("warning: public pages exist but no _file/ data is public; their charts will get 401 for anonymous visitors");
```

- [ ] **Step 3: .dev.vars.example and README**

```
# .dev.vars.example — copy to .dev.vars for `wrangler dev`
BETTER_AUTH_SECRET=change-me-to-32-random-chars
# RESEND_API_KEY=re_...   (omit to print emails to the console)
```

README sections, each a short paragraph or list: What it is (two sentences). How it works (the route order and the gate rules from the spec, plus the data-protection point). Quick start (`npm install`, copy `.dev.vars.example`, `wrangler d1 create doorman` and paste the id, `wrangler d1 migrations apply doorman --local`, `wrangler dev`, first sign-up becomes admin). Config reference (every key in `doorman.config.js` with one line each; page rules with the `*` / `**` semantics, first-match, runtime auto-public, and the warning about `_import/` being public code). Deploying (`deploy.sh`, secrets via `wrangler secret put`, routes in `wrangler.jsonc`, Resend domain verification). Admin (what the page does, self-protection rules). Limits (no OAuth, no per-role rules, sidebar still shows disabled pages).

- [ ] **Step 4: Verify locally**

Run: `npm test` (all pass), then `cp .dev.vars.example .dev.vars`, `npx wrangler d1 migrations apply doorman --local`, `npx wrangler dev` and in another shell:

```bash
curl -si http://localhost:8787/ -H 'accept: text/html' | head -3      # 302 to /_door/login
curl -si http://localhost:8787/_door/login | head -3                    # 200
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "deploy script, rule checker, README, dev vars example"
```

---

### Task 12: ICR rollout on a staging hostname

**Files:**
- Modify (doorman repo): `wrangler.jsonc`, `doorman.config.js`
- Modify (icr repo, later): `campaignhq/deploy.sh`, `campaignhq/worker/` (retire), `campaignhq/README.md`

This task is operational. Matt runs the steps that touch the Cloudflare account; the executor prepares the files and the commands.

- [ ] **Step 1: Production config**

`wrangler.jsonc` adds, for the ICR deployment:

```jsonc
"account_id": "af8ac7eb1f7ec617e14702e69ce0d4c7",
"vars": {"BASE_URL": "https://doorman.healthcampaigns.org"},
"routes": [{"pattern": "doorman.healthcampaigns.org", "custom_domain": true}]
```

`doorman.config.js`:

```js
export default {
  site: {name: "campaignhq", dist: "../icr/campaignhq/dist"},
  brand: {title: "Campaign Dashboards", accent: "#0b57d0", logo: null},
  auth: {allowedDomains: ["ona.io"], sessionDays: 30},
  mail: {from: "doorman@healthcampaigns.org", adminNotify: "mberg@ona.io"},
  pages: [{match: "about", access: "public"}]
};
```

- [ ] **Step 2: One-time account setup (Matt)**

```bash
npx wrangler d1 create doorman            # paste database_id into wrangler.jsonc
npx wrangler secret put BETTER_AUTH_SECRET # openssl rand -base64 32
npx wrangler secret put RESEND_API_KEY     # after verifying healthcampaigns.org in Resend
./deploy.sh --skip-build                   # site already in R2 under _site/campaignhq/ from campaignhq/deploy.sh
```

- [ ] **Step 3: Verify on staging**

- Anonymous `https://doorman.healthcampaigns.org/` → login page. `/about` → renders. `/_file/...parquet` → 401.
- Sign up as mberg@ona.io → first user, admin, active. Dashboards load, DuckDB queries run, maps render (pmtiles range requests through the gate).
- Sign up a second address → pending page; approve from `/_door/admin`; approval email arrives; the account gets in.
- Sign out, sign in with a magic link.

- [ ] **Step 4: Move the production hostname**

In `icr/campaignhq/wrangler.toml` remove the `dashboards.healthcampaigns.org` route and redeploy the old Worker (it keeps `monitor.*` for the 301, but the 301 must now point at a host doorman serves; simplest is to add `monitor.healthcampaigns.org` as a second route on doorman and drop it from campaignhq, then add a host redirect for `monitor.*` in doorman's Worker: an `app.use` that 301s any hostname other than `new URL(env.BASE_URL).hostname`). Then add `{"pattern": "dashboards.healthcampaigns.org", "custom_domain": true}` to doorman's routes, set `BASE_URL` to `https://dashboards.healthcampaigns.org`, and deploy.

- [ ] **Step 5: Retire the old worker in icr**

PR to icr: delete `campaignhq/worker/`, `campaignhq/wrangler.toml`, and the worker steps in `campaignhq/deploy.sh` (leave build + rclone sync, or point the README at doorman's `deploy.sh`). Note in `campaignhq/README.md` that the site is served by doorman.

- [ ] **Step 6: Commit and tag**

```bash
git add -A && git commit -m "ICR deployment config for campaignhq" && git tag v0.1.0 && git push --tags
```

---

## Self-review notes

- Spec coverage: route order (T6), page rules incl. runtime auto-public and cleanUrl keys (T2), gate table incl. 401 vs 302 (T3, T6), private cache headers (T4), status field, first-user admin, allowlisted domains (T5), login/magic/signup/pending/sign-out pages (T7), admin page with self-protection and CSRF (T8), Resend with console fallback and tolerant callers (T9), rate limit and fail-closed 503 (T5, T6, T10), deploy script and rule warning (T11), rollout (T12). Non-goal "hide disabled pages from sidebar" stays out.
- The spec says the deploy script inlines the config; here the Worker imports `doorman.config.js` directly, which wrangler bundles. Same effect, less machinery.
- `TEST_PAGES` is a test-only binding read by `configFor`; it is undefined in production.
- Type consistency: `decide` returns `{kind}` objects consumed in T6; `readSession` returns `{user, session}` and `c.get("session")` holds that same shape; `csrfToken(secret, sessionToken)` uses `session.session.token` in T8.
