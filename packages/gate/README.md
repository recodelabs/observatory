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

## The account bar

On every dashboard page a signed-in user opens, the gate adds a small box in the bottom-right
corner with:
- their email, and the Keycloak realm if they signed in with one;
- a "Sign out" button;
- for admins, a "Manage users" link to `/_obs/admin`.

It is added as the page is served, so builds don't change. A page with the bar is sent as
`private, no-store`. Anonymous visitors to public pages don't get it.

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
- **Admins** see every site and use the admin page. An admin is someone who meets a
  condition in `auth.admins`, or was made an admin on the admin page. A disabled user is
  never an admin. The first person to sign up is *not* made an admin (doorman did that);
  the first admin is the verified address that `auth.admins` names.

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
`OIDC_<ID>_SECRET` for each Keycloak provider, if any. Without
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
