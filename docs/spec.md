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
- **Editing:** let admins edit a page's Markdown in the gate. The first version commits
  each save to GitHub. Deploying on commit, and later pull requests with preview builds,
  follow.
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
              ├─ /_obs/edit/…     the Markdown editor; saves commit to GitHub (phase 4, admins)
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
| `packages/editor` | The Markdown editor in the gate (phase 4) | new |
| `packages/cli/template` | Starter site: config, one page, two data loaders | new |

A project that uses Observatory keeps its sites and config in its own repo. It installs
the packages from npm (`@recodelabs/observatory-cli`, `-components`, and later `-gate`),
published from this repo's workspaces on each release tag. (GitHub Packages was the first
plan; the org's billing limit blocked it, 2026-10-22.) An npm git dependency would resolve
to the workspace root, which exports nothing, so that is not how they are installed.
doorman's deployment folders (`import … from "doorman"`) change to the new package names.

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
  cloudflare: {
    account: "…", bucket: "icr", d1: "observatory",
    rclone: "r2",                 // the rclone remote for the bucket
    sites: "_site/campaignhq/",   // where builds go: this folder plus each site's path
    worker: "worker"              // the folder `observatory deploy` runs `wrangler deploy` in
  },
  brand: {title: "Campaign Dashboards", accent: "#0b57d0", logo: null},
  repo: {github: "recodelabs/icr", branch: "main", root: "dashboards"},   // what the editor commits to

  warehouses: {
    main: {r2: ""},          // the bucket root
    uga:  {r2: "uga/", local: "../country/uganda/warehouse"}   // local: for --local builds
  },

  // Each site says who may see it. A site without `access` needs sign-in, so a new site is
  // never public by accident.
  sites: [
    {name: "main",   path: "/",    dir: "sites/main",   warehouse: "main", access: "public"},
    {name: "uganda", path: "/ug/", dir: "sites/uganda", warehouse: "uga",
     access: [{oidc: "uga", group: "/dashboards"}, {emailDomain: "ona.io"}, {role: "admin"}]}
  ],

  auth: {
    sessionDays: 30,          // email sessions
    oidcSessionHours: 12,     // OIDC sessions: absolute lifetime
    claimsMaxAge: 900,        // seconds before an OIDC session's groups and roles are refreshed
    admins: [{oidc: "uga", group: "/dashboards-admins"}, {email: "mberg@ona.io"}],  // see "Two levels of access"
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

doorman's request flow stays. It changes in four ways, and doorman's rule that makes the
first person to register an active admin is removed (see "Who is an admin").

### 1. Several sites behind one Worker

- **Routing:** each site's `path` maps to its build at `cloudflare.sites` plus the path
  in R2 (`/ug/` → `_site/campaignhq/ug/`), so bucket folders mirror URLs. Requests
  are routed by the longest path prefix that matches. Within a site, the existing serving
  stays: clean URLs, range requests, ETag/304, and the brotli copy of the DuckDB engine.
- **Rules:** access rules match the full request path (`ug/plan`,
  `ug/_file/data/targets.…parquet`). A site's access covers its pages, its data files and
  its own modules, because each site's build is under its own path.
- **What it replaces:** the Campaign Dashboards Worker (`campaignhq/worker`) and the
  doorman Worker. Both hostnames stay: `doorman.healthcampaigns.org` redirects to the
  canonical host.

### 2. Sign-in with Keycloak

Keycloak is optional. Email sign-in (Better Auth) is the default, and most projects need
nothing else. A project that has Keycloak, such as the ICR, lists its realms under
`auth.oidc`.

- **How it works:**
  - Better Auth's generic OAuth/OIDC support, with one provider per Keycloak realm.
  - The login page shows a "Sign in with …" button for each provider, next to the email
    sign-in.
- **What the gate keeps from the ID token:** each user's groups (the `groups` claim) and
  realm roles (`realm_roles`). They're stored per provider account: keyed by provider and
  the token's subject, never per user, and written only by the gate's sign-in callback.
- **Which provider a session came from:** each session records how it was signed in (the
  OIDC provider id, or `email`). An `{oidc: …}` condition is met only by a session signed in
  through that provider. A user who also has an email login doesn't carry OIDC groups into
  an email session.
- **Group changes take effect within a bounded time:**
  - the claims stored for a session are valid for 15 minutes (`auth.claimsMaxAge`);
  - after that, the next request refreshes them with the provider's refresh token, and a
    user removed from a group loses access then;
  - if the refresh fails (the user was disabled or signed out in Keycloak), the session
    ends;
  - OIDC sessions also have an absolute lifetime (`auth.oidcSessionHours`, default 12),
    which use doesn't extend;
  - Keycloak's back-channel logout to the gate can come later, to end sessions straight
    away.
- **Accounts:** an OIDC user is `active` immediately. Keycloak has already decided who
  they are, and the access rules decide what they see.
- **Email users:** they keep doorman's approval flow. That covers partners outside
  Keycloak. An account counts for `{emailDomain}` and `{email}` conditions only once its
  address is verified: by signing in with a magic link, or by the verification email a
  password sign-up gets. An unverified sign-up from an allowed domain is not activated
  either. This is a change from doorman, which trusted the domain of an unverified address.
- **Keycloak setup, per realm**, with `packages/gate/keycloak/oidc-client.sh`:
  - a confidential client named `observatory`, standard flow with PKCE (S256) only, with
    the redirect URI `https://<host>/auth/callback/<id>` (Better Auth's OAuth callback
    under the gate's `/auth` base path);
  - mappers that add the `groups` claim (full paths) and the `realm_roles` claim to the ID
    token, access token and userinfo;
  - the groups the rules name, e.g. `/dashboards` in `uga`.

### 3. Rules by who the user is

- **Where access is set:** on each site (`sites[].access`), with optional per-path
  exceptions (`access[]`, first match wins). Until the manifest below exists, an exception
  can only make a page public: a stricter one would close the page but not its data, and a
  public one fails closed (the page opens, its site's closed data stays closed). To close
  part of a site, make it a site of its own. A site without `access` needs sign-in, so a
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
  - `{role: "admin"}`: an admin (see below).
- **Two levels of access: read-only and admin.**
  - **Read-only** is what a site's `access` grants: the user can see that site's pages and
    their data, nothing else. Most users have only this.
  - **Admin** is for the whole host, not per site:
    - sees every site, whatever its `access`;
    - uses the admin page (`/_obs/admin`): approves or disables email users, and sees who
      signed in with Keycloak and which groups gave them access;
    - edits the dashboards: each page's Markdown source (`sites/<site>/src/*.md`), first
      in the gate's editor, which commits each save to GitHub (phase 4). Read-only users
      never see the editor.
  - **Who is an admin:** anyone who meets one of the conditions in `auth.admins`, checked
    at every request like site access. An email user can also be made an admin on the
    admin page (stored in D1). With Keycloak, admins are a group, so they are managed where
    the other users are:

    ```js
    auth: {
      admins: [{oidc: "uga", group: "/dashboards-admins"}, {email: "mberg@ona.io"}],
      …
    }
    ```

    The `{email}` entry is how the first admin gets in before anyone else exists: it
    matches only a verified email. It replaces doorman's rule that the first person to
    register becomes an active admin, which is removed. Admin rights from a Keycloak group
    follow the same refresh as other claims (`claimsMaxAge`), so removing someone from the
    group ends their admin rights within 15 minutes.
  - **Admins publish code.** A Framework page is code: its Markdown runs JavaScript and
    raw HTML in every viewer's browser, with that viewer's session. So editing a page is
    publishing code, and admin rights are given only to people trusted as much as those
    with write access to the repo, who can already change any page. A page's code can call
    the gate's own endpoints as whoever views it, admins included; the editor's checks
    below stop other sites, not the pages themselves. If a less trusted `editor` level is
    added later, the editor must move to its own origin and edits must be reviewed before
    they deploy.
- **The order of checks**, the same for pages, data files and modules:
  1. a path whose rule is `disabled` is refused to everyone, admins too;
  2. a public path is served, without looking at the session;
  3. without a session, the user is sent to sign in;
  4. a disabled user is refused;
  5. a user who isn't active is sent to the pending page. That covers an email user
     waiting for approval or for their address to be confirmed (doorman's approval flow
     stays). A Keycloak user is active on sign-in, and so is a verified address that
     `auth.admins` names or that is in `auth.email.allowedDomains`;
  6. an admin is allowed. An admin meets every rule, so a file shared by several pages is
     allowed too;
  7. anyone else is checked against the path's rule: the site's `access`, the exceptions,
     and the manifest below. `"signed-in"` means an active user.

  A disabled user can still open public pages, which anyone can; looking up the session
  on every public request would cost a database read for nothing.
  The same order guards the admin page and the editor, which need step 6. A user is
  disabled when an admin disables them in D1. That wins over every admin grant, from
  `auth.admins` or from D1.
  - **Later, if needed:** per-site admins, and an `editor` level that can edit pages but
    not manage users. v1 has the two levels only.
- **The account bar:** the gate adds a small box to every page a signed-in user opens. It
  shows who they are and a sign-out button, and for admins a "Manage users" link to the
  admin page. Later it carries the "Edit this page" link. Pages with it are
  `private, no-store`.
- **Failures:**
  - not signed in → the login page (or 401 for data requests);
  - signed in but not allowed → a 403 page that says which group grants access.
- **A page's data and modules are never less restricted than the page.**
  - At deploy time, `observatory check` reads each built page's references. These are its
    data files (`_file/…`) and its own modules (`_import/…`, which can hold page code and
    embedded data). It writes a manifest of the rule for every file, and the gate applies
    the manifest.
  - **A file used by one page** gets that page's rule.
  - **A file used by several pages** gets all of their rules at once: a viewer must meet
    every one of them. For example, a file shared by a page open to group A and a page open
    to group B is visible only to people in both. The config can make a file stricter than
    that, never more open.
  - **An exception (`access[]`) that would leave a page's data or modules more open than
    the page** stops the deploy.
  - **A public page whose data is restricted** gets a warning, because its charts would
    break.
- **Framework's runtime is public within a site that has public pages.**
  - What's made public is an allowlist of the files Framework ships for its client: the
    scripts, styles and fonts under `_observablehq/…`, and the npm packages under
    `_npm/…`. None of them hold project code or data.
  - **Not on the allowlist:**
    - `_import/…`, the project's own modules. It follows the manifest above.
    - Framework's search index (`_observablehq/minisearch.json`), which holds the titles
      and text of every page. In a site whose pages don't all share one rule,
      `observatory build` turns search off (v1). In a site where they do, the index gets
      that rule.
  - doorman made all three runtime folders public as soon as any page was public. That
    could expose a restricted page's modules and search text.

### 4. The Info Gateway

- The FHIR Info Gateway trusts the same Keycloak realms. So the users and groups that
  open a dashboard are the same ones that can call the FHIR API.
- **Later (phase 6):** the gate can keep the user's Keycloak access token, so that a page
  can query the gateway for live data as that user.

## The CLI

`observatory` wraps Framework's own commands and adds what the ICR's scripts do today.

| Command | What it does |
|---|---|
| `observatory new <site>` | Creates `sites/<site>` from the template and prints the config entry to add |
| `observatory dev <site>` | Runs Framework's preview with DuckDB 2.0 swapped in and `DUCKDB_AGENT_MODE=0`. The data comes from the local warehouse copy, or the cached pull |
| `observatory pull [<site>…]` | Copies each site's warehouse from R2 into the cache (`~/.cache/observatory/`) |
| `observatory build [<site>…]` | Pulls, clears Framework's cached loader outputs, builds, and adds brotli copies of `.wasm` files |
| `observatory deploy [<site>…]` | Builds, uploads each build to its bucket folder, and deploys the Worker in `cloudflare.worker`. `--dry-run` shows what would change. From gate v1 it also applies D1 migrations |
| `observatory check` | Checks the config and each site's Framework config, and lists each site's access, warehouse and bucket folder. From gate v1 it also lists which pages and data files each rule makes public, signed-in or restricted, and warns about mismatches |

- **Deploying sites one at a time:** uploads are per site, so deploying one site never
  deletes another's. A site's upload leaves the folders of the sites under its path alone.
  It stops if the bucket holds pages in a folder that is neither in the build nor a
  configured site; `--prune` deletes them. (The ICR's `deploy.sh` had this risk: the main
  site's sync deleted any folder not in its list.)
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

Admins edit the dashboards in the gate. The first version saves straight to GitHub;
preview builds and pull requests come later.

- **Phase 4: the editor, committing to GitHub.**
  - **Where:** `/_obs/edit/` lists each site's pages. `/_obs/edit/<site>/<page>` opens
    one page's Markdown in CodeMirror, with the live page beside it.
  - **Which files:** the server builds the list of editable files from the config and
    GitHub's tree API:
    - the repository and branch come only from `repo` in the config;
    - each site's source folder is `repo.root` + `sites[].dir` + Framework's `root`;
    - a file is listed only if it is an existing regular file (a blob, not a symlink or
      submodule) ending in `.md` under that folder.

    Requests name a file by site and its path in that list, and anything not on the list
    is refused, whatever its spelling: `..`, encoded slashes, absolute paths.
  - **The link in:** on every page an admin sees, the gate adds an "Edit this page" link to
    the editor. It adds the link when it serves the page, so read-only users never get
    it and the static build doesn't change.
  - **Every editor request checks the user.** That covers listing, reading and saving:
    the gate checks on the server that the user is an admin, with fresh claims and the
    disabled check. Hiding the link is not the protection.
  - **Saving** is a `POST`, accepted only with:
    - an `Origin` header equal to the configured host;
    - a CSRF token tied to the session. The editor page carries the token; the blob SHA
      is not a secret.

    The gate then commits the file to `repo.branch` through GitHub's contents API. Each
    commit is one file:
    - its message is "Edit <site>/<page>.md", with the admin's own short note if they
      add one;
    - its author is the admin's name and email; the committer is the GitHub App.
  - **Conflicts:** the editor keeps the file's blob SHA from when it was opened. If the
    file changed on GitHub since then, GitHub refuses the save. The editor then says so
    and offers to reload, so nobody overwrites someone else's edit.
  - **What a save doesn't do:** it doesn't change the live site. The new page shows after
    the next deploy (`observatory deploy`; from CI in phase 5). The editor says this after
    each save.
  - **GitHub access:** a GitHub App installed on the repo, with `contents: write` and
    nothing else, on that repo only. For every read and save, the gate:
    1. signs a short-lived JWT with the App's private key, a Worker secret;
    2. exchanges it for an installation access token, asking only for that repository and
       `contents: write`;
    3. calls the contents API with that token.

    Neither token leaves the Worker: neither goes in a response or a log.
  - **Limits (v1):**
    - Markdown pages only; no data loaders, components or config;
    - no new or deleted pages;
    - files over 1 MB are refused.
- **Phase 5: deploy on commit, then previews.**
  - A GitHub Action runs `observatory deploy` for the site whose files changed on
    `repo.branch`, so a save goes live without anyone running the CLI.
  - Later, if direct commits become too risky, saving can open a pull request instead.
    An Action would build a preview to `_preview/<pr>/`, served at `/_preview/<pr>/…`
    to admins, and merging would deploy.

## Moving the ICR onto Observatory

1. Move `campaignhq/` to `dashboards/sites/main` and `dashboards/sites/uganda` in
   recodelabs/icr. Add the config, and point `deploy.sh`'s users at
   `observatory deploy`. The Sierra Leone sites become two more sites that build from
   local data.
2. Deploy the gate at dashboards.healthcampaigns.org, replacing the `campaignhq` Worker,
   with these access rules:
   - Nigeria demo pages: public, as today (decided 2026-10-22);
   - `/ug/`: the `uga` realm's `/dashboards` group (read-only), `ona.io` email users,
     and admins (the `/dashboards-admins` group, and the bootstrap email).
3. Move doorman's users from its D1 database. It's the same schema, and the migrations
   come along.
4. Redirect `doorman.healthcampaigns.org` to the canonical host.
5. Archive recodelabs/doorman. Close doorman#2 and icr#172.

## Phases

1. **Repo:** doorman becomes `packages/gate`, plus this spec. *(Done in the first
   commits.)*
2. **CLI and components:** lifted from the ICR, with the template site and the move of
   `campaignhq` (step 1 above, without the gate change). *(CLI, components and template in
   PR #2; the move of `campaignhq` is a PR in recodelabs/icr.)*
3. **Gate v1:** several sites, Keycloak sign-in, group rules and `/_obs` routes. Then
   cutover (steps 2, 4 and 5). `/ug/` goes behind the `uga` realm.
4. **The editor:** admins edit a page's Markdown in the gate, and each save commits to
   GitHub.
5. **Deploy on commit** (a GitHub Action), then pull requests with preview builds if
   needed.
6. **A data endpoint:** the gate serves warehouse tables to allowed users, so pages can
   query current data without a rebuild. It also keeps Keycloak tokens for calls to the
   Info Gateway.

## Open questions

- **Keycloak users for `/ug/`.** The `uga` realm is set up (2026-10-22, with
  `packages/gate/keycloak/oidc-client.sh`):
  - a confidential client `observatory`, with the gate's callbacks for
    dashboards.healthcampaigns.org, doorman.healthcampaigns.org and localhost:8787;
  - `groups` and `realm_roles` mappers;
  - the groups `/dashboards` (read-only) and `/dashboards-admins` (admins).

  The realm has no human users yet. Who goes in each group, and who creates their accounts?
- **The GitHub App for the editor** (phase 4): created in the recodelabs org and installed
  on recodelabs/icr only, with `contents: write`.
- **Mail:** Resend, with a verified `healthcampaigns.org` sender, as doorman uses now.
- **Route prefix:** `/_obs/…` replaces doorman's `/_door/…`. Old login links redirect.
