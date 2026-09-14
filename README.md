# doorman

Login and access control in front of a static site build (Observable Framework first).
Cloudflare Worker + Better Auth + D1 + R2.

Design: [docs/spec.md](docs/spec.md). Implementation plan: [docs/plan.md](docs/plan.md).

## What it is

A Cloudflare Worker that sits in front of a static site stored in R2 and requires a
session before serving it. Better Auth (email+password and magic-link sign-in) handles
users and sessions in D1; new accounts need an admin's approval before they can see
anything. The static site itself needs no changes — doorman serves it the same way the
site's own Worker would.

## How it works

Requests are matched in this order:

1. `/auth/*` — Better Auth's own handler. Always public.
2. `/_door/login`, `/_door/signup`, `/_door/pending` — rendered pages. Always public.
3. `/_door/admin` and its `/_door/admin/<action>` form posts — require an active
   session with role `admin`; anyone else gets a plain 404 (the page's existence isn't
   revealed).
4. Everything else goes through the page rules, then the session gate, then R2:
   - The request path is resolved against `doorman.config.js`'s `pages` list to
     `public`, `protected`, or `disabled`.
   - `disabled` → 404 for everyone, including admins.
   - `protected` with no session → 302 to `/_door/login?next=<path>` for page
     navigations (`Accept: text/html`), 401 with no body for everything else (so a
     stale tab or a cached DuckDB fetch fails visibly instead of quietly caching a
     redirect).
   - `protected` with a session whose user `status` is `pending` or `disabled` → 302
     to `/_door/pending` for navigations, 403 otherwise.
   - `protected` with an `active` session, or `public` regardless of session → served
     from R2 at `_site/<site.name>/…`, with cleanUrls, range requests, ETag/304, and
     content types carried over from the static site's own Worker.

**Data is protected too.** Framework builds fetch `.parquet` and `.pmtiles` files from
`_file/…` on the same origin, so the browser sends the session cookie on those fetches
same as on page loads — the gate covers them with no changes to the site build.
Protected responses get `Cache-Control: private, …` so the Cloudflare edge never caches
a protected file for an anonymous request. If D1 is unreachable the gate fails closed:
503, never a served file.

## Using it

doorman is a library. A deployment is a small directory in the site's own repo holding
three files, with doorman installed from git:

```
mysite/doorman/
  package.json        "doorman": "github:recodelabs/doorman#v0.2.0", plus wrangler
  worker.js           import {createDoorman} from "doorman"; export default createDoorman(config)
  doorman.config.js   site, brand, auth, mail, pages — see the config reference below
  wrangler.jsonc      account, D1 + R2 bindings, BASE_URL, routes; migrations_dir points
                      at node_modules/doorman/migrations
```

`example/` in this repo is a complete, generic copy of that layout (`example/worker.js`
imports from `../src` instead of the package). A deployment's `wrangler.jsonc` needs the
`nodejs_compat` flag, a `DB` D1 binding, a `SITE` R2 binding, and `vars.BASE_URL` set to
the canonical https origin; the two secrets are `BETTER_AUTH_SECRET` (32+ random chars)
and `RESEND_API_KEY`.

Before the first deploy:

```bash
npx wrangler d1 create doorman             # paste database_id into wrangler.jsonc
npx wrangler secret put BETTER_AUTH_SECRET # openssl rand -base64 32
npx wrangler secret put RESEND_API_KEY     # after verifying mail.from's domain in Resend
```

Then `npx doorman-deploy` (see Deploying). The **first** account created ever becomes an
admin with `status: active` automatically, so the deployer can never be locked out.
Everyone after that starts `pending` until an admin approves them at `/_door/admin`,
unless their email domain is in `auth.allowedDomains`.

## Developing doorman

```bash
npm install
cp .dev.vars.example .dev.vars          # set BETTER_AUTH_SECRET to 32+ random chars
npx wrangler d1 migrations apply doorman --local
npx wrangler dev                        # serves example/ config at http://localhost:8787
npm test
```

The repo's `wrangler.jsonc` is a local-only config (no account, no routes); `wrangler dev`
runs `example/worker.js`. `wrangler dev` does not set `cf-connecting-ip`, the header
Better Auth's rate limiter buckets on, so every local request shares one counter and
the limits (10 sign-ins and 5 sign-ups a minute) behave differently than in
production. And once any page rule is `public`, the Framework runtime chunks
(`_observablehq/`, `_npm/`, `_import/`) are served `public, max-age=31536000, immutable`
— browsers and the Cloudflare edge may hold them for a year, so anything unhashed under
those prefixes will not pick up a redeploy.

## Config reference

Everything lives in the deployment's `doorman.config.js`, imported by its Worker entry
file (wrangler bundles it — no filesystem access at runtime):

- `site.name` — the R2 key prefix; the site is served from `_site/<name>/…`.
- `site.dist` — path to the built site, relative to the deployment directory. Used
  only by `doorman-deploy` and `doorman-check-rules`, never read by the deployed Worker.
- `brand.title` — shown in page titles and the footer.
- `brand.accent` — CSS color for buttons and links on doorman's own pages.
- `brand.logo` — optional image URL shown above the page heading; `null` to omit.
- `auth.allowedDomains` — email domains that get `status: active` immediately on
  sign-up, skipping admin approval. Case-insensitive; compared against everything
  after the `@`.
- `auth.sessionDays` — session cookie lifetime in days (default 30).
- `mail.from` — the Resend "from" address for magic links and approval emails.
- `mail.adminNotify` — email address notified when a new account signs up and needs
  approval; `null` to disable that notification.
- `pages` — an ordered list of `{match, access}` rules; first match wins, anything
  unmatched is `protected`. `access` is one of `public`, `protected`, `disabled`.

Page rule globs match the request path with no leading slash, and also match the same
path with `.html`/`/index.html`/`index.html` stripped, so `{match: "about"}` covers
`about`, `about.html`, and `about/index.html` alike. `*` matches within one path
segment; `**` crosses `/`. Example:

```js
pages: [
  {match: "about",                        access: "public"},
  {match: "_file/data/calendar.*.parquet", access: "public"},
  {match: "ntd",                          access: "disabled"},
  {match: "ntd/**",                       access: "disabled"},
]
```

Framework's runtime paths — `_observablehq/**`, `_npm/**`, `_import/**` — become
`public` automatically the moment *any* rule in the list is `public`, so a public page
can still load its JS. An explicit `public`, `protected`, or `disabled` rule naming one
of those prefixes overrides the automatic behavior. **`_import/` ships to the browser
as plain JavaScript once it's public — never put secrets or private query logic in a
data loader that ends up there.**

`_file/**` (the built data files) stays `protected` by default; it is *not* covered by
the runtime auto-public rule, so a public page whose charts read from `_file/` needs
its own explicit public rule on that data, or the page will render but its charts will
get 401s for anonymous visitors. `doorman-check-rules` (see below) warns about
exactly this.

## Deploying

Both commands run from the deployment directory (the one with `doorman.config.js` and
`wrangler.jsonc`); `npx` finds them once doorman is installed.

`npx doorman-deploy [--skip-build] [--dry-run]` does the whole rollout: builds the site
(`npm run build` in `site.dist/..`, skip with `--skip-build`), runs `doorman-check-rules`
as an advisory check, `rclone sync`s `site.dist` to `r2:<bucket>/_site/<site.name>/`,
applies D1 migrations against the remote database, and runs `wrangler deploy`.
`--dry-run` does the build and the rclone dry-run sync but skips migrating and
deploying. It needs an `r2:` rclone remote configured for the Cloudflare account
(`R2_REMOTE` to use a different remote name, `R2_BUCKET` to override the bucket read
from `wrangler.jsonc`). Without rclone, sync the build some other way and run the last
two steps by hand:

```bash
npx wrangler d1 migrations apply doorman --remote
npx wrangler deploy
```

`npx doorman-check-rules` loads the config, walks `site.dist`, and prints which `.html`
files resolve `public` and which resolve `disabled`. It warns — but always exits 0, so
it never blocks a deploy — when public pages exist but no `_file/` object is public.

Moving hostnames: doorman 301s any hostname other than `new URL(env.BASE_URL).hostname`
to the canonical host, path and query intact, so an old hostname can be listed in
`routes` alongside the canonical one and it redirects. Custom domains can only point at
one Worker at a time, so release a hostname from its previous Worker before deploying
doorman with it.

Upgrading: bump the git tag in the deployment's `package.json`, `npm install`, and
deploy. Migrations ship with the package, so `doorman-deploy` (or the manual
`migrations apply`) picks up new ones.

## Admin

`/_door/admin` lists every user — email, status, role, created date, last sign-in —
with one-click form-post actions per row: approve (pending → active, sends the
approval email), enable/disable, make admin/remove admin, delete. Every action posts
to `/_door/admin/<action>` with a CSRF token bound to the session (HMAC of the session
token, checked with a constant-time comparison). An admin cannot disable, demote, or
delete their own account, so there is always at least one working admin.

The page itself is gated by session role, not by a page rule: anything but an active
session with `role: admin` gets a 404, not a redirect, so its existence isn't
advertised to signed-out or non-admin visitors.

## Limits

- No OAuth providers — email+password and magic link only.
- No per-role page rules. Access is `public` / `protected` / `disabled`; there's no
  "visible to admins only" short of the `/_door/admin` page itself.
- One site per Worker. Running several sites means several doorman deployments.
- The sidebar in the static build still lists disabled pages — doorman blocks the
  request, it doesn't rewrite the site's navigation. Remove the link from the
  Framework config to actually hide it.
- No password reset flow beyond "email me a magic link".
