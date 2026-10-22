---
title: doorman — login and access control for static sites
status: draft
date: 2026-09-11
---

# doorman design

Login and access control for static sites, Observable Framework first, with the data files
protected too. A Cloudflare Worker wraps a static build: Better Auth handles users
and sessions, D1 stores them, R2 holds the built site. The Framework site is a black
box to doorman; it needs no changes.

The serving half is the usual "static site from R2" Worker; doorman keeps that logic
and puts a session gate in front of it. doorman is a library: each site keeps its own
deployment directory (config, wrangler.jsonc, entry file) and installs doorman from git.

## Goals

- Whole site behind login by default. Every HTML page, script, parquet, and pmtiles
  file goes through the same session check.
- Per-path rules that make listed pages public or disabled.
- Sign-in by email + password or magic link. Anyone can sign up; an admin approves.
- A minimal admin page: list users, approve, disable, set role, delete.
- Reusable for any Framework site; one deployment directory per site.

## Non-goals (v1)

- OAuth providers (Google, Microsoft).
- Per-role page rules. Rules are public / protected / disabled only.
- Multiple sites in one Worker.
- npm packaging. v1 is a template repo cloned per site.
- Password reset beyond "send me a magic link".
- Hiding disabled pages from the site's sidebar. The build is static; remove the
  page from the Framework config to hide the link.

## Architecture

```
browser ──▶ Cloudflare Worker (Hono)
              ├─ /auth/*        Better Auth handler          (public)
              ├─ /_door/login   login + signup pages         (public)
              ├─ /_door/pending "awaiting approval" page     (public)
              ├─ /_door/admin   user table + actions         (role: admin)
              └─ /*             page rules → session gate → R2 static serve
D1  ─ users, sessions, verification tokens (Better Auth schema + `status` field)
R2  ─ `_site/<name>/…`  the Framework dist/
Resend ─ magic-link and approval emails (console fallback when no API key)
```

Runtime: Cloudflare Workers. Bindings: D1 `DB`, R2 `SITE`. Secrets:
`BETTER_AUTH_SECRET`, `RESEND_API_KEY`. The site is stored in R2 rather than Workers
Static Assets because DuckDB-WASM's engine builds exceed the 25 MiB per-file cap.

## Request flow

Routes are matched in this order:

1. `/auth/*` → Better Auth. Always public.
2. `/_door/login`, `/_door/signup`, `/_door/pending` → rendered pages. Always public. A signed-in
   active user hitting `/_door/login` is redirected to `next` or `/`.
3. `/_door/admin` and its form-post actions → require session with role `admin`.
   Otherwise 404 (do not reveal the page exists).
4. Everything else:
   1. Resolve the request path against the page rules (below). Result is `public`,
      `protected`, or `disabled`.
   2. `disabled` → 404 for everyone, including admins.
   3. `protected` → read session from cookie.
      - No session → 302 to `/_door/login?next=<path>` for navigations
        (`Accept: text/html`); 401 with no body for asset and data fetches, so a
        stale tab fails visibly instead of caching a redirect into DuckDB.
      - Session, user `status` is `pending` or `disabled` → 302 to `/_door/pending`
        for navigations, 403 for fetches.
      - Session, `active` → serve.
   4. `public` → serve.
   5. Serve = the usual R2 static-site logic: cleanUrls (`/about` →
      `about.html`, `/` → `index.html`), range requests, ETag/304, content types,
      site 404 page. Cache headers change: protected responses are
      `Cache-Control: private, max-age=…` so the Cloudflare edge never caches a
      protected file for an anonymous request; hashed assets keep the long max-age,
      still private. Public responses keep the site's public cache headers.

Data protection works because Framework builds fetch parquet and pmtiles from the
same origin under `/_file/…`. The browser sends the session cookie on same-origin
fetches, including range requests, so the gate covers them with no site changes.

If D1 is unreachable, the gate fails closed: 503, never a served file.

## Page rules

`doorman.config.js` carries an ordered list. First match wins. Anything unmatched is
`protected`. Patterns are path globs matched against the request path with no leading
slash; `*` does not cross `/`, `**` does.

```js
pages: [
  {match: "about",                        access: "public"},
  {match: "_file/data/calendar.*.parquet", access: "public"},
  {match: "ntd",                          access: "disabled"},
  {match: "ntd/**",                       access: "disabled"},
]
```

Rules for the Framework runtime:

- `_observablehq/**`, `_npm/**`, `_import/**` are code, not data. They become
  `public` automatically whenever any rule is `public`, so a public page can load.
  A `disabled` or `protected` rule naming them explicitly still wins. Consequence,
  stated in the README: never put secrets in a data loader's JavaScript output, since
  `_import/` ships to the browser.
- `_file/**` is data and stays `protected` unless a rule says otherwise. Framework
  hashes file names (`_file/data/calendar.abc123.parquet`), so public data rules
  use a glob on the base name and extension.
- A public page whose data is not also public renders but its charts fail with 401.
  The deploy script warns when a public rule matches an HTML page and no public rule
  matches anything under `_file/`.

## Auth

Better Auth on D1 through Kysely's D1 dialect. Better Auth is constructed per
request because Workers expose bindings only at request time; the construction is
cheap and cached on the Hono context.

Plugins:

- **email-and-password** — sign-up and sign-in.
- **magic-link** — passwordless sign-in and the only password-reset path in v1.
- **admin** — roles (`user`, `admin`), list users, ban/unban. We do not use ban for
  approval; see `status`.

Extra user field `status`: `pending` | `active` | `disabled`.

- A sign-up hook sets `pending`. If `auth.allowedDomains` is set and the email's
  domain is in it, the hook sets `active` instead.
- The first user ever created gets role `admin` and status `active`, so the deployer
  can never be locked out.
- Sign-in of a `pending` or `disabled` user succeeds at the Better Auth level but the
  gate sends them to `/_door/pending`. This keeps Better Auth's flows untouched.

Sessions: stored in D1, cookie `HttpOnly; Secure; SameSite=Lax`, lifetime
`auth.sessionDays` (default 30). Rate limiting: Better Auth's built-in limiter on
`/auth/sign-in/*` and `/auth/magic-link/*`, per IP.

Email: Resend HTTP API. When `RESEND_API_KEY` is unset the sender logs the message and
link to the console, which is the local-dev path. Emails sent: magic link, "your
account was approved", and an admin notification on new sign-up.

## Pages the Worker renders

Plain HTML templates as JavaScript template strings, one shared stylesheet, no
client-side framework. Themed by `brand.title`, `brand.logo`, `brand.accent`.

- **Login** (`/_door/login`): email + password form, a "email me a link" button, a
  sign-up link. Auth errors render back into this page as a message.
- **Sign up** (`/_door/signup`): email, password. On success, redirect to
  `/_door/pending`.
- **Pending** (`/_door/pending`): "your account is waiting for approval", sign-out.
  Also shown to `disabled` users with different wording.
- **Admin** (`/_door/admin`): table of users — email, status, role, created, last
  sign-in — with per-row form-post actions: approve, disable, make admin, remove
  admin, delete. Actions POST to `/_door/admin/<action>` with a CSRF token bound to
  the session. An admin cannot disable or delete themself.

## Config

```js
// doorman.config.js
export default {
  site:  {name: "mysite", dist: "../dist"},
  brand: {title: "My Site", accent: "#0b57d0", logo: null},
  auth:  {allowedDomains: ["example.org"], sessionDays: 30},
  mail:  {from: "doorman@example.org", adminNotify: "admin@example.org"},
  pages: [
    {match: "about", access: "public"},
  ],
};
```

`site.dist` is used only by the deploy script. `site.name` is the R2 prefix
(`_site/<name>/`). Everything else is read by the Worker at build time: the deploy
script inlines the config into the bundle so the Worker never reads the filesystem.

## Repo layout

```
doorman/
  README.md
  package.json          hono, better-auth, kysely, kysely-d1, wrangler, vitest
  wrangler.toml         bindings, routes (per deployment)
  example/              a generic deployment directory (worker.js, doorman.config.js)
  migrations/           D1 SQL from `better-auth generate` + the status column
  bin/doorman-deploy    build site → rclone sync dist → wrangler d1 migrations apply → wrangler deploy
  bin/doorman-check-rules  advisory: which pages resolve public/disabled
  src/
    index.js            createApp(config) / createDoorman(config); route order as above
    gate.js             page-rule resolution + session decision table (pure)
    serve.js            R2 static serving
    auth.js             Better Auth factory, plugins, hooks, status field
    mail.js             Resend sender + console fallback
    pages/              login.js signup.js pending.js admin.js layout.js style.css
  test/
    gate.test.js        decision table
    rules.test.js       glob matching, runtime auto-public, first-match
    serve.test.js       cleanUrls, range, 304, 404
    e2e.test.js         miniflare: fixture dist + local D1, anonymous vs active vs pending
```

## Error handling

- Auth errors: rendered into the login/signup page, never raw JSON to a browser.
- Missing R2 object: site 404 page if present, plain 404 otherwise.
- D1 down: 503, fail closed.
- Mail send failure: logged; sign-up still succeeds and the pending page tells the
  user to contact the admin.
- Unknown `/_door/*` path: 404.

## Testing

Vitest with `@cloudflare/vitest-pool-workers`.

- `gate.js` is pure: (rule, session) → decision. Table-driven tests over every
  combination of {public, protected, disabled} × {none, pending, disabled, active,
  admin} × {navigation, fetch}.
- Rules: glob semantics, first-match, runtime auto-public trigger, explicit override.
- Serve: the standard R2 static behaviors, with cache header changes.
- End to end against a fixture `dist/` (one HTML page, one `_file/…parquet`, one
  `_observablehq/` chunk) and a local D1: anonymous GET of the page → 302, of the
  parquet → 401; after sign-up → pending; after admin approve → 200 with correct
  `Content-Range` on a ranged parquet fetch.
- Manual: a real site build on a staging hostname before the production route moves.

## Rollout for a site

1. Add a deployment directory to the site's repo (see README "Using it"). Deploy to a
   staging hostname pointed at the site's existing R2 prefix.
2. Sign up as the first user (becomes admin). Verify pages and data fetches work
   signed in and are blocked signed out.
3. Move the production custom-domain route from the site's old Worker to doorman.
   Old hostnames can stay listed in `routes`; doorman 301s them to BASE_URL.
4. Retire the old Worker and point the site's deploy at `doorman-deploy`.

## Open questions

None blocking. Later: OAuth providers, per-role rules, one Worker serving several
sites, publishing to npm.
