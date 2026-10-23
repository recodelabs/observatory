# @recodelabs/observatory-gate

The gate: a Cloudflare Worker that serves an Observatory project's dashboard sites from R2 and
decides who sees what. Better Auth for sign-in, D1 for users and sessions. It started as
doorman (recodelabs/doorman); the design is in [`docs/spec.md`](../../docs/spec.md), "The gate".

## How a request is handled

1. `/auth/*`: Better Auth's own endpoints. Always reachable.
2. `/_obs/login`, `/_obs/signup`, `/_obs/pending`, `/_obs/signout`: the gate's pages.
   `/_obs/admin`: the admin page, for admins only (anyone else gets a 404). Old `/_door/…`
   links are redirected to `/_obs/…`.
3. Everything else is a site path. It belongs to the site with the longest matching
   `path` in the config, and gets a rule: the first matching exception in `access`, or else
   its site's `access`. Then, in order:
   1. a `disabled` path is 404 for everyone, admins too;
   2. a `public` path is served, without looking at the session;
   3. no session: a page is redirected to `/_obs/login?next=…`, anything else gets 401;
   4. a disabled user gets 403;
   5. a user who isn't active is sent to `/_obs/pending` (403 for data);
   6. an admin is served;
   7. anyone else is served if the rule lets them in, or gets a 403 page that lists who can.

Files are served from the bucket at the config's `cloudflare.sites` folder plus the request
path, so `/ug/plan` is `_site/campaignhq/ug/plan.html`. Clean URLs, range requests,
ETag/304 and brotli copies of `.wasm` files work as in the ICR's old campaignhq Worker. A
gated response is `cache-control: private`, so the Cloudflare edge never caches it for
someone else. If D1 can't be reached, the gate fails closed: 503, never a file.

**Framework's runtime** (`_observablehq/…` and `_npm/…`) is public in a site that has any
public page, so those pages load for anonymous visitors. It holds no project code or data.
The site's own modules (`_import/…`), data (`_file/…`) and search index
(`_observablehq/minisearch.json`) follow the site's rule.

## The gate's own pages

The sign-in, sign-up and Settings pages use the look of Framework's light theme (grey page,
white cards, Source Serif 4 headings, Framework's table style), so they match the dashboards.
`brand.title` is the heading on every page, with the page's name under it (except on the
sign-in page, where the form is the whole page); `brand.accent` changes the link colour (Framework's
blue when unset) and `brand.logo` adds an image above the title. The gate serves the
Observatory logo at `/_obs/observatory.svg`, so `logo: "/_obs/observatory.svg"` shows it.

## The account panel

On every dashboard page a signed-in user opens, the gate adds a small panel with:
- their email, and the Keycloak realm if they signed in with one;
- for admins, "Edit this page" (when the config names a repo; see below) and "Settings", the
  user manager at `/_obs/admin`;
- a "Sign out" button.

On a Framework page it sits at the foot of the sidebar, and opens and closes with it. A page
without the sidebar gets it in the bottom-left corner. It is added as the page is served, so
builds don't change. A page with the panel is sent as `private, no-store`. Anonymous visitors
to public pages don't get it.

## Inviting people

On the user manager an admin can invite someone by email and tick the sites they can see, or
make them an admin. The gate creates the account (active, with no password), opens the ticked
sites to it, and emails a link to the sign-in page with their address filled in. They sign in
with an emailed link; following it confirms the address.

The sites on offer are the ones whose `access` is a list of conditions; public and
`signed-in` sites need no invitation. Each user's row has the same checkboxes, so an admin can
open or close sites later. These grants (D1 table `siteGrant`) add to a site's own rule:
whoever meets the rule still gets in. A disabled path stays closed, and a disabled user stays
out, whatever they were granted.

## Who is who

Email sign-in (Better Auth) is the default and needs nothing else. Keycloak, or any OpenID
Connect provider, is optional: list it under `auth.oidc` and set its client secret, and the
login page gets a "Sign in with …" button for it.

- **Email users** sign up with a password, or sign in with a link by email. Every sign-up
  gets an email to confirm the address. An account starts as pending. It becomes active
  when an admin approves it, or as soon as its address is confirmed if the address:
  - is in `auth.email.allowedDomains`, or
  - is named by `auth.admins`.
- **Rules** (`access` in the config) are `"public"`, `"signed-in"` (any active user),
  `"disabled"`, or a list of conditions, any one of which is enough:
  `{email}`, `{emailDomain}` (verified addresses only), `{oidc, group}`, `{oidc, role}`
  (Keycloak), `{role: "admin"}`.
- **Keycloak users** (`auth.oidc: [{id, name, issuer, clientId}]`, secret
  `OIDC_<ID>_SECRET`):
  - **On sign-in:** they're active straight away, since Keycloak decided who they are. The
    gate stores their groups and realm roles, from the provider's tokens, for that provider
    account.
  - **Which sessions count:** a group or role counts only in a session signed in through
    that provider. An email session of the same person carries none.
  - **Refresh:** after `auth.claimsMaxAge` (15 minutes) the gate refreshes the groups with
    the refresh token, so someone taken out of a group loses access then. If the refresh
    fails, the session ends.
  - **Lifetime:** a Keycloak session also ends after `auth.oidcSessionHours` (12), however
    much it's used.
  - **Tokens:** they stay in D1. The account endpoints that would hand them to a browser
    are closed.
  - **Keycloak setup:** `keycloak/oidc-client.sh` sets up a realm's client, mappers and
    groups.
- **People an admin invited** see the sites the admin ticked (see "Inviting people").
- **Admins** see every site and use the admin page. An admin is someone who meets a
  condition in `auth.admins`, or was made an admin on the admin page. A disabled user is
  never an admin. The first person to sign up is *not* made an admin (doorman did that);
  the first admin is the verified address that `auth.admins` names.

## Editing pages

Admins can edit a dashboard page's Markdown in the gate. Each save commits that one file to
GitHub. The config says where:

```js
repo: {github: "recodelabs/icr", branch: "main", root: "dashboards", app: 5445395},
sites: [{name: "uganda", path: "/ug/", dir: "sites/uganda", …}]
```

A site's pages are the `.md` files in `repo.root` + `dir` + `root` (Framework's source folder,
`"src"` unless the site sets `root`). Sites without `dir` can't be edited.

- `/_obs/edit/` lists every site's pages. `/_obs/edit/<site>/<page>` shows the page's Markdown
  next to the live page. The "Edit this page" link in the account panel opens it.
- A save is one commit to `repo.branch`, titled "Edit <site>/<file>", plus the admin's note
  if they add one. Its author is the admin; the GitHub App commits it.
- If the file changed on GitHub after the editor opened it, the save is refused and the text
  stays in the box.
- A save doesn't change the site. The page changes at the next deploy.
- Only existing `.md` files can be edited, up to 1 MB: no new or deleted pages, data loaders,
  components or config. Symlinks and submodules are never listed.
- Every request checks that the user is an admin, and saves need the session's CSRF token and
  this host's `Origin`.

The gate reaches GitHub through a GitHub App (`repo.app`, its App ID). Install it on the repo
only, with "Contents: read and write" and nothing else. The App's private key is the Worker
secret `GITHUB_APP_PRIVATE_KEY`. The `.pem` GitHub gives you (PKCS#1) works as it is, and so does
PKCS#8. For each request the gate signs a JWT with the key, swaps it for an installation token
limited to that repo and `contents: write`, and uses that. No token goes in a response or a
log.

## A deployment

A project imports the gate in its Worker entry file, with its `observatory.config.js`:

```js
import {createGate} from "@recodelabs/observatory-gate";
import config from "../observatory.config.js";
export default createGate(config);
```

Its `wrangler.jsonc` needs:
- the `nodejs_compat` flag;
- a `DB` D1 binding, with `migrations_dir` pointing at this package's `migrations/`;
- a `SITE` R2 binding for the bucket;
- `vars.BASE_URL`, the canonical https origin.

The secrets are `BETTER_AUTH_SECRET` (32+ random characters), `RESEND_API_KEY`, and
`OIDC_<ID>_SECRET` for each Keycloak provider, if any, and `GITHUB_APP_PRIVATE_KEY` for the
editor. Without
`RESEND_API_KEY`, mail is written to the log instead of being sent.

`observatory deploy` will apply the D1 migrations and deploy the gate (phase 3, next).

## Developing

```bash
npm install                                  # at the repo root
cd packages/gate
cp .dev.vars.example .dev.vars               # set BETTER_AUTH_SECRET to 32+ random chars
npx wrangler d1 migrations apply observatory --local
npx wrangler dev                             # serves example/ at http://localhost:8787
npm test
```

`wrangler dev` runs `example/worker.js` with `example/observatory.config.js`. It doesn't set
`cf-connecting-ip`, the header Better Auth's rate limiter counts by, so locally every
request shares one counter.
