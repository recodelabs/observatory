# @recodelabs/observatory-cli

The `observatory` command: preview, build and deploy Observable Framework sites that read a
warehouse in R2. Lifted from the ICR's `campaignhq/deploy.sh` and `duckdb-wasm2.sh`.

## Install

The packages are on npm. In the project that holds your sites:

```bash
npm install @observablehq/framework@1.13.4 @recodelabs/observatory-cli @recodelabs/observatory-components
```

Node 22 or later.

The commands also use:

- **rclone**, with a remote for the R2 bucket (`r2` by default), for `pull`, `build` and `deploy`;
- **gh**, signed in, the first time a site uses DuckDB (to download DuckDB-Wasm 2.0);
- **duckdb** and whatever else the sites' data loaders call;
- **wrangler**, through npx, when the config names a host Worker.

## A project

```
observatory.config.js
package.json
sites/
  main/      observablehq.config.js, src/ (pages, src/data/ loaders)
  uganda/
worker/      optional: the Worker that serves the sites (wrangler config)
```

```js
// observatory.config.js
export default {
  host: "https://dashboards.example.org",
  cloudflare: {
    bucket: "icr",              // the R2 bucket
    rclone: "r2",               // the rclone remote for it (default r2)
    sites: "_site/main/",       // where builds go in the bucket (default _site/)
    worker: "gate",             // optional: a folder to `wrangler deploy` after uploading
    d1: "observatory"           // optional: the gate's D1 database, migrated before the deploy
  },
  warehouses: {
    main: {r2: ""},                              // the bucket root
    uga:  {r2: "uga/", local: "../country/uganda/warehouse"}
  },
  sites: [
    {name: "main",   path: "/",    dir: "sites/main",   warehouse: "main", access: "public"},
    {name: "uganda", path: "/ug/", dir: "sites/uganda", warehouse: "uga",
     access: [{oidc: "uga", group: "/dashboards"}]},
    {name: "sl",     path: "/sl/", dir: "sites/sl"}   // no warehouse: its loaders find their own data
  ]
};
```

- **Bucket folders mirror the URLs.** A site is uploaded to `cloudflare.sites` plus its
  path: `/ug/` goes to `_site/main/ug/`.
- **Nested sites are separate.** Uploading the site at `/` leaves the folders of the sites
  under it alone.
- **Unknown folders stop an upload.** An upload would delete any folder whose
  `index.html` is not in the new build. If such a folder belongs to no configured site,
  the upload stops; `--prune` deletes it anyway. This catches a site missing from the
  config, at any depth.
- **`access`** is read by the gate (phase 3). A site without it needs sign-in.
  `observatory check` lists each site's level.

## Commands

| Command | What it does |
|---|---|
| `observatory new <name> [--dir DIR]` | Copies the template to `sites/<name>` and prints the config entry to add |
| `observatory dev <site> [--local] [--pull] [preview options…]` | Framework's preview, with DuckDB 2.0 and `DATA` set. Data comes from the cached warehouse (pulled if there is none): `--pull` refreshes it, `--local` uses the warehouse's `local` copy. Other options, such as `--port 3000 --host 0.0.0.0`, go to `observable preview` |
| `observatory pull [<site>…]` | Copies the sites' warehouses from R2 to `~/.cache/observatory/warehouses/` |
| `observatory build [<site>…] [--local]` | Pulls, clears Framework's cached loader outputs, builds, and adds brotli copies of `.wasm` files. All sites when none are named |
| `observatory deploy [<site>…] [--local] [--skip-build] [--dry-run] [--prune] [--no-worker]` | Builds and uploads each site. Then, in `cloudflare.worker`, applies the D1 migrations of `cloudflare.d1` (with `--dry-run`, lists them) and runs `wrangler deploy` |
| `observatory check` | Checks the config and each site's Framework config; prints each site's access, warehouse, bucket folder and nested sites |

## The gate

The gate (`@recodelabs/observatory-gate`) is the Worker that serves the sites and decides who
sees them. A project adds it in a folder of its own, named by `cloudflare.worker`:

```js
// gate/worker.js
import {createGate} from "@recodelabs/observatory-gate";
import config from "../observatory.config.js";
export default createGate(config);
```

```jsonc
// gate/wrangler.jsonc
{
  "name": "dashboards",
  "main": "worker.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "…",
  "vars": {"BASE_URL": "https://dashboards.example.org"},
  "d1_databases": [{"binding": "DB", "database_name": "observatory", "database_id": "…",
    "migrations_dir": "../node_modules/@recodelabs/observatory-gate/migrations"}],
  "r2_buckets": [{"binding": "SITE", "bucket_name": "icr"}],
  "routes": [{"pattern": "dashboards.example.org", "custom_domain": true}]
}
```

Before the first deploy:
1. Create the D1 database (`npx wrangler d1 create observatory`).
2. Set the secrets:
   - `BETTER_AUTH_SECRET`: 32+ random characters;
   - `RESEND_API_KEY`, for email;
   - `OIDC_<ID>_SECRET` for each Keycloak provider.

See the gate's README for its access rules and sign-in.

## Data loaders

The CLI sets `DATA` to the warehouse folder (`parquet/`, `tiles/`, `manifest.json`,
`catalog.sql`) and `DUCKDB_AGENT_MODE=0`, which stops DuckDB's CLI from printing a banner into
loader output when it runs under an AI agent. A loader reads a table from its first
partition folder down, so files the producer keeps beside the data are skipped:

```bash
#!/usr/bin/env bash
set -euo pipefail
duckdb -c "COPY (
  SELECT id, name, population
  FROM read_parquet('$DATA/parquet/places/*=*/**/*.parquet', hive_partitioning=true, union_by_name=true)
) TO '/dev/stdout' (FORMAT parquet)"
```

Framework reuses a loader's output until the loader file changes. `build` and `deploy`
clear every loader output in the site's cache (all but Framework's own `_npm`, `_node`,
`_jsr`, `_observablehq` and `_build.json`), so every build reads the warehouse again. `dev` doesn't. To see new data in a
running preview, delete the loader's output under `src/.observablehq/cache/`.

`pull` mirrors the warehouse into `~/.cache/observatory/warehouses/<remote>/<bucket>/<folder>`.
The bucket root is `@root`. Files the bucket no longer has are removed from the cache.
The build output folder is Framework's `output`, `dist` by default.

## DuckDB 2.0

Framework 1.13 comes with DuckDB-Wasm 1.29 (DuckDB 1.1.1). For a site with DuckDB pages,
`dev` and `build` do the following:

1. Change Framework in `node_modules` to load the "base" build of DuckDB-Wasm 2.0.
2. Put the 2.0 engine, worker and module into the site's npm cache.

The first time a site is built, it is built twice: the first build fills Framework's npm
cache.

The 2.0 files come from a DuckDB-Wasm CI run, are checked by sha256, and are kept in
`~/.cache/observatory/duckdb-wasm2/`. Set
`duckdb: {extensions: {json: null, parquet: null}}` in each site's `observablehq.config.js`;
`check` warns when it is missing. This step goes once DuckDB-Wasm 2.0 is on npm and
Framework uses it.
