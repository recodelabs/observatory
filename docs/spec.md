# Observatory design

<sub>`v0.1 · draft · 2026-10-22`</sub>

Observatory is a toolkit for publishing dashboards built with
[Observable Framework](https://observablehq.com/framework/) on top of a data warehouse,
on Cloudflare. It packages an approach that was first built for the ICR's Campaign
Dashboards (recodelabs/icr, `campaignhq/`), so that other projects can use it:

- **The warehouse:** a folder of parquet tables, map tiles and a manifest, in R2.
- **The dashboards:** static Framework sites, built from the warehouse.
- **The browser:** DuckDB-WASM queries each page's data.
- **The gate:** a Cloudflare Worker that serves the sites and decides who sees what.

Observatory is not tied to FHIR. Any process that writes the warehouse layout can feed
it: fhir-pipes in the ICR, a dbt project, a Python job.

It absorbs **doorman** (recodelabs/doorman), which becomes `packages/gate` with its
history. doorman is no longer maintained on its own.

## Goals

- **Start quickly:** create a dashboard site, preview it and deploy it with one CLI and
  one config file.
- **One source:** build each site from a warehouse in R2, so a deploy can run from any
  machine or from CI. It always shows what the warehouse holds.
- **One host:** serve several sites behind one gate, each at its own path
  (`/`, `/ug/` …).
- **Access control:**
  - per path, by group;
  - users sign in with Keycloak (OpenID Connect), or with email for people outside
    Keycloak;
  - an admin page for the email users.
- **The data too:** protect a page's data files with the same rules as the page.
- **Editing:** let people edit a page's source from the site. The first version is a
  link to GitHub's editor. Later, an editor in the gate opens a pull request and shows a
  preview build.
- **Shared parts:** maps (MapLibre, PMTiles), linked filters, DuckDB helpers and a
  default look.

## Non-goals (v1)

- **Other hosting:** anything but Cloudflare (Workers, R2, D1).
- **Live editing:** previews that update while you type. Edits go through a build.
- **A query server.** Pages query their own data in the browser. A data endpoint in the
  gate comes later (phase 6).
- **Being a hosted service for other organisations.** Each project deploys its own gate.

## Architecture

```
                 warehouse producers (fhir-pipes, dbt, scripts)
                                │  push
                                ▼
R2 bucket ── <warehouse>/ parquet/ tiles/ manifest.json catalog.sql     (private)
         └── _site/<site>/  Framework builds                             (served by the gate)
                                ▲
           observatory deploy   │  pull warehouse → build each site → upload
           (laptop or CI)       │
                                │
browser ──▶ gate (Cloudflare Worker, Hono)
              ├─ /auth/*          Better Auth: email, magic link, OIDC callbacks   (public)
              ├─ /_obs/login …    sign-in, pending and admin pages
              ├─ /_obs/edit/…     page-source editor                (phase 5, role: editor)
              └─ /<site path>/*   access rules → session → R2 _site/<site>/…
D1 ── users, sessions, accounts (with each user's OIDC groups), verification tokens
Keycloak ── auth.healthcampaigns.org, one realm per country, as an OIDC provider
```

## Packages

| Package | What it is | Where it starts from |
|---|---|---|
| `packages/gate` | The Worker: sign-in, access rules, serving sites from R2, admin page | doorman (this repo's history) |
| `packages/cli` | `observatory` command: `new`, `dev`, `pull`, `build`, `deploy` | icr `campaignhq/deploy.sh`, `duckdb-wasm2.sh` |
| `packages/components` | Framework components: maps, filters, DuckDB helpers, theme | icr `campaignhq/src/components/` |
| `packages/editor` | The editor in the gate (phase 5) | new |
| `templates/site` | Starter site: config, one page, one data loader | new |

A project that uses Observatory keeps its sites and config in its own repo and installs
the packages from git, as it did with doorman:

```
dashboards/
  observatory.config.js
  sites/
    main/        a Framework project (src/, observablehq.config.js)
    uganda/
  gate/          wrangler.jsonc (account, bindings, routes); secrets set with wrangler
```

## Config

One file, `observatory.config.js`, read by the CLI and bundled into the gate:

```js
export default {
  host: "https://dashboards.healthcampaigns.org",
  cloudflare: {account: "…", bucket: "icr", d1: "observatory"},
  brand: {title: "Campaign Dashboards", accent: "#0b57d0", logo: null},
  repo: {github: "recodelabs/icr", branch: "main", root: "dashboards"},   // for "Edit this page"

  warehouses: {
    main: {r2: ""},          // the bucket root
    uga:  {r2: "uga/"}
  },

  // Each site says who may see it. A site without `access` needs sign-in, so a new site is
  // never public by accident.
  sites: [
    {name: "main",   path: "/",    dir: "sites/main",   warehouse: "main", access: "public"},
    {name: "uganda", path: "/ug/", dir: "sites/uganda", warehouse: "uga",
     access: [{oidc: "uga", group: "/dashboards"}, {emailDomain: "ona.io"}, {role: "admin"}]}
  ],

  auth: {
    sessionDays: 30,
    email: {allowedDomains: ["ona.io"], from: "observatory@healthcampaigns.org", adminNotify: "…"},
    oidc: [
      {id: "uga", name: "Uganda (Keycloak)", issuer: "https://auth.healthcampaigns.org/realms/uga"},
      {id: "icr", name: "ICR (Keycloak)",    issuer: "https://auth.healthcampaigns.org/realms/icr"}
    ]
  },

  // Optional exceptions within a site, first match wins, e.g. one public page of a
  // protected site: {match: "ug/about", allow: "public"}.
  access: []
};
```

The client secret of each OIDC provider is a Worker secret (`OIDC_UGA_SECRET` …), never
written in the config.

## The gate

doorman's request flow stays. It changes in four ways.

### 1. Several sites behind one Worker

- **Routing:** each site's `path` maps to its build at `_site/<name>/` in R2. Requests
  are routed by the longest path prefix that matches. Within a site, the existing serving
  stays: clean URLs, range requests, ETag/304, and the brotli copy of the DuckDB engine.
- **Rules:** access rules match the full request path (`ug/plan`,
  `ug/_file/data/targets.…parquet`). So one rule covers a site's pages and its data.
- **What it replaces:** the Campaign Dashboards Worker (`campaignhq/worker`) and the
  doorman Worker. Both hostnames stay: `doorman.healthcampaigns.org` redirects to the
  canonical host.

### 2. Sign-in with Keycloak

- **How it works:**
  - Better Auth's generic OAuth/OIDC support, with one provider per Keycloak realm.
  - The login page shows a "Sign in with …" button for each provider, next to the email
    sign-in.
- **What the gate keeps from the ID token:** each user's groups (the `groups` claim) and
  realm roles, stored in D1. They're refreshed at every sign-in.
- **Accounts:** an OIDC user is `active` immediately. Keycloak has already decided who
  they are, and the access rules decide what they see.
- **Email users:** they keep doorman's approval flow. That covers partners outside
  Keycloak.
- **Keycloak setup, per realm** (documented in the README):
  - a confidential client named `observatory`, with the redirect URI
    `https://<host>/auth/oauth2/callback/<id>`;
  - a "Group Membership" mapper that adds the `groups` claim to the ID token;
  - the groups the rules name, e.g. `/dashboards` in `uga`.

### 3. Rules by who the user is

- **Where access is set:** on each site (`sites[].access`), with optional per-path
  exceptions (`access[]`, first match wins). A site without `access` needs sign-in, so a
  new site is never public by accident. In the ICR, the Nigeria demo site is `public` and
  the login applies to `/ug/` and new sites.
- **What access can be:**
  - `"public"`
  - `"signed-in"`
  - `"disabled"`
  - a list of conditions, of which any one is enough.
- **The conditions:**
  - `{oidc, group}` and `{oidc, role}`: a user who signed in with that provider and is in
    that group or has that realm role;
  - `{emailDomain}` and `{email}`: email users;
  - `{role}`: a gate role (`admin`, `editor`).
- **Failures:**
  - not signed in → the login page (or 401 for data requests);
  - signed in but not allowed → a 403 page that says which group grants access.
- **Unchanged from doorman:**
  - Framework's runtime paths (`_observablehq`, `_npm`, `_import`) become public once
    any page is public;
  - `observatory check` warns when a public page's data is not public.

### 4. The Info Gateway

- The FHIR Info Gateway trusts the same Keycloak realms. So the users and groups that
  open a dashboard are the same ones that can call the FHIR API.
- **Later (phase 6):** the gate can keep the user's Keycloak access token, so that a page
  can query the gateway for live data as that user.

## The CLI

`observatory` wraps Framework's own commands and adds what the ICR's scripts do today.

| Command | What it does |
|---|---|
| `observatory new <site>` | Creates `sites/<site>` from the template and adds it to the config |
| `observatory dev <site>` | Runs Framework's preview with DuckDB 2.0 swapped in and `DUCKDB_AGENT_MODE=0`. The data comes from the local warehouse copy, or the cached pull |
| `observatory pull [<site>…]` | Copies each site's warehouse from R2 into the cache (`~/.cache/observatory/`) |
| `observatory build [<site>…]` | Pulls, clears Framework's cached loader outputs, builds, and adds brotli copies of `.wasm` files |
| `observatory deploy [<site>…]` | Builds, uploads each build to `_site/<name>/`, applies D1 migrations and deploys the gate. `--dry-run` shows what would change |
| `observatory check` | Lists which pages and data files each rule makes public, signed-in or restricted, and warns about mismatches |

- **Deploying sites one at a time:** uploads are per site, so deploying one site never
  deletes another's. (The ICR's `deploy.sh` had this risk, because the main site's sync
  owned the whole prefix.)
- **Loaders:** read the warehouse path from `DATA`, which the CLI sets.
- **DuckDB 2.0:** the CLI does what `duckdb-wasm2.sh` does today, until DuckDB-Wasm 2.0
  is on npm and Framework uses it.

## The warehouse contract

Observatory reads a warehouse and never writes one. A warehouse is a folder in the bucket
with this layout:

```
<prefix>/parquet/<table>/<partition>=…/*.parquet    one folder per table, hive-partitioned
<prefix>/tiles/*.pmtiles                             optional map tiles
<prefix>/manifest.json                               refreshed_at, tables and row counts
<prefix>/catalog.sql                                 optional DuckDB views over the tables
```

Loaders read tables with globs that start at the first partition (`country=*/**`), so
any metadata next to the data is skipped. Producers can add their own files (the ICR adds
a Portolan catalog), and Observatory ignores them.

## Editing a page

- **Phase 4: an "Edit this page" link.**
  - The CLI adds the link to every page's footer. Framework's footer can be a function
    of the page path.
  - The link opens GitHub's editor on `repo.github/repo.root/sites/<site>/src/<page>.md`.
    Saving opens a commit or pull request.
  - A GitHub Action then runs `observatory deploy`.
  - The link shows only to users with the gate role `editor` or `admin`. The gate adds
    it when it serves the page, so the static build doesn't change.
- **Phase 5: an editor in the gate.**
  - `/_obs/edit/<site>/<page>` opens the page's source in CodeMirror, with the page
    beside it.
  - Saving commits to a branch and opens a pull request. The gate uses a GitHub App that
    has rights to that repo.
  - An Action builds a preview to `_preview/<pr>/`, and the gate serves it at
    `/_preview/<pr>/…` to editors.
  - Merging the pull request deploys.

## Moving the ICR onto Observatory

1. Move `campaignhq/` to `dashboards/sites/main` and `dashboards/sites/uganda` in
   recodelabs/icr. Add the config, and point `deploy.sh`'s users at
   `observatory deploy`. The Sierra Leone sites become two more sites that build from
   local data.
2. Deploy the gate at dashboards.healthcampaigns.org, replacing the `campaignhq` Worker,
   with these access rules:
   - Nigeria demo pages: public, as today (decided 2026-10-22);
   - `/ug/`: the `uga` realm's `/dashboards` group, `ona.io` email users, and admins.
3. Move doorman's users from its D1 database. It's the same schema, and the migrations
   come along.
4. Redirect `doorman.healthcampaigns.org` to the canonical host.
5. Archive recodelabs/doorman. Close doorman#2 and icr#172.

## Phases

1. **Repo:** doorman becomes `packages/gate`, plus this spec. *(Done in the first
   commits.)*
2. **CLI and components:** lifted from the ICR, with the template site and the move of
   `campaignhq` (steps 1 and 3 above, without the gate change).
3. **Gate v1:** several sites, Keycloak sign-in, group rules and `/_obs` routes. Then
   cutover (steps 2, 4 and 5). `/ug/` goes behind the `uga` realm.
4. **CI deploy and the "Edit this page" link.**
5. **The editor in the gate, with preview builds.**
6. **A data endpoint:** the gate serves warehouse tables to allowed users, so pages can
   query current data without a rebuild. It also keeps Keycloak tokens for calls to the
   Info Gateway.

## Open questions

- **Keycloak users for `/ug/`.** The `uga` realm is set up (2026-10-22, with
  `packages/gate/keycloak/oidc-client.sh`): it has a confidential client `observatory` with
  the gate's callbacks for dashboards.healthcampaigns.org, doorman.healthcampaigns.org and
  localhost:8787, a `groups` mapper, and the group `/dashboards`. The realm has no human
  users yet; who should be in `/dashboards`, and who creates their accounts?
- **Mail:** Resend, with a verified `healthcampaigns.org` sender, as doorman uses now.
- **Route prefix:** `/_obs/…` replaces doorman's `/_door/…`. Old login links redirect.
