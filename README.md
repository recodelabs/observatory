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

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars          # set BETTER_AUTH_SECRET to 32+ random chars
npx wrangler d1 create doorman          # paste the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply doorman --local
npx wrangler dev
```

Open `http://localhost:8787/_door/signup` and create an account — the **first** account
created ever becomes an admin with `status: active` automatically, so the deployer can
never be locked out. Everyone after that starts `pending` until an admin approves them
at `/_door/admin`, unless their email domain is in `auth.allowedDomains`.

## Config reference

Everything lives in `doorman.config.js`, imported directly by the Worker (wrangler
bundles it — no filesystem access at runtime):

- `site.name` — the R2 key prefix; the site is served from `_site/<name>/…`.
- `site.dist` — path to the built site, relative to the repo root. Used only by
  `deploy.sh` and `scripts/check-rules.js`, never read by the deployed Worker.
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
get 401s for anonymous visitors. `scripts/check-rules.js` (see below) warns about
exactly this.

## Deploying

`./deploy.sh [--skip-build] [--dry-run]` does the whole rollout: builds the site
(`npm run build` in `site.dist/..`, skip with `--skip-build`), runs
`scripts/check-rules.js` as an advisory check, `rclone sync`s `site.dist` to
`r2:<bucket>/_site/<site.name>/`, applies D1 migrations against the remote database,
and runs `wrangler deploy`. `--dry-run` does the build and the rclone dry-run sync but
skips migrating and deploying. It needs an `r2:` rclone remote configured for the
Cloudflare account (`R2_REMOTE` to use a different remote name, `R2_BUCKET` to override
the bucket read from `wrangler.jsonc`).

`scripts/check-rules.js` (also `npm run check-rules`) loads the config, walks
`site.dist`, and prints which `.html` files resolve `public` and which resolve
`disabled`. It warns — but always exits 0, so it never blocks a deploy — when public
pages exist but no `_file/` object is public.

Before the first deploy of a given site:

1. `npx wrangler d1 create doorman`, paste the `database_id` into `wrangler.jsonc`.
2. `npx wrangler secret put BETTER_AUTH_SECRET` (`openssl rand -base64 32`).
3. `npx wrangler secret put RESEND_API_KEY`, after verifying the sending domain in
   Resend. Without this secret, magic links and notification emails are logged to the
   Worker console instead of sent — fine for dev, not for production.
4. Add `account_id` and a `routes` entry to `wrangler.jsonc` for the production
   hostname (see the commented example in that file).

### First deployment for ICR

This is the runbook for putting `doorman` in front of ICR's `campaignhq` dashboards.
These are steps the project lead runs by hand against the live Cloudflare account —
nothing here is automated by this repo.

**1. Create the D1 database and secrets:**

```bash
npx wrangler d1 create doorman            # paste database_id into wrangler.jsonc
npx wrangler secret put BETTER_AUTH_SECRET # openssl rand -base64 32
npx wrangler secret put RESEND_API_KEY     # after verifying healthcampaigns.org in Resend
```

**2. Deploy** (the `campaignhq` site is already built and synced to R2 under
`_site/campaignhq/` by `icr/campaignhq/deploy.sh`, so this run skips the build):

```bash
./deploy.sh --skip-build
```

**3. Verify on staging** (`https://doorman.healthcampaigns.org`):

- Anonymous `/` redirects to the login page. `/about` renders without signing in.
  `/_file/…parquet` returns 401 anonymously.
- Sign up as `mberg@ona.io` — first user, so it becomes admin and is active
  immediately. Dashboards load, DuckDB queries run, maps render (pmtiles range
  requests pass through the gate).
- Sign up a second address — lands on the pending page. Approve it from
  `/_door/admin`; the approval email arrives; the account can now sign in.
- Sign out, then sign back in with a magic link instead of a password.

**4. Move the production hostname.** In `icr/campaignhq/wrangler.toml`, remove the
`dashboards.healthcampaigns.org` route and redeploy that Worker (it keeps
`monitor.*`'s 301 redirect, but that redirect must now point at a host doorman
serves — add `monitor.healthcampaigns.org` as a second route on doorman and drop it
from campaignhq, then add a host-redirect middleware in doorman that 301s any
hostname other than `new URL(env.BASE_URL).hostname`). Then add
`{"pattern": "dashboards.healthcampaigns.org", "custom_domain": true}` to doorman's
`routes`, set `vars.BASE_URL` to `https://dashboards.healthcampaigns.org`, and deploy.

**5. Retire the old Worker.** PR to the `icr` repo: delete `campaignhq/worker/` and
`campaignhq/wrangler.toml`, drop the worker-deploy steps from `campaignhq/deploy.sh`
(keep the build + rclone sync steps, or point its README at doorman's `deploy.sh`),
and note in `campaignhq/README.md` that the site is now served by doorman.

**6. Commit and tag** (in this repo, once the config in steps 1–4 has been applied):

```bash
git add -A && git commit -m "ICR deployment config for campaignhq" && git tag v0.1.0 && git push --tags
```

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
