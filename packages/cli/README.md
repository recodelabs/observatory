# @recodelabs/observatory-cli

The `observatory` command: preview, build and deploy Observable Framework sites that read a
warehouse in R2. Lifted from the ICR's `campaignhq/deploy.sh` and `duckdb-wasm2.sh`.

## Install

The packages are on GitHub Packages. In the project that holds your sites:

```bash
echo "@recodelabs:registry=https://npm.pkg.github.com" >> .npmrc
npm install @observablehq/framework@1.13.4 @recodelabs/observatory-cli @recodelabs/observatory-components
```

Installing needs a GitHub token with `read:packages` (`npm login --registry https://npm.pkg.github.com`).
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
    worker: "worker"            // optional: a folder to `wrangler deploy` after uploading
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
- **Unknown folders stop an upload.** If the bucket folder holds pages in a folder that is
  neither in the new build nor a configured site, the upload stops. `--prune` deletes them.
- **`access`** is read by the gate (phase 3). A site without it needs sign-in.
  `observatory check` lists each site's level.

## Commands

| Command | What it does |
|---|---|
| `observatory new <name> [--dir DIR]` | Copies the template to `sites/<name>` and prints the config entry to add |
| `observatory dev <site> [--local] [--pull] [preview options…]` | Framework's preview, with DuckDB 2.0 and `DATA` set. Data comes from the cached warehouse (pulled if there is none): `--pull` refreshes it, `--local` uses the warehouse's `local` copy. Other options, such as `--port 3000 --host 0.0.0.0`, go to `observable preview` |
| `observatory pull [<site>…]` | Copies the sites' warehouses from R2 to `~/.cache/observatory/warehouses/` |
| `observatory build [<site>…] [--local]` | Pulls, clears Framework's cached loader outputs, builds, and adds brotli copies of `.wasm` files. All sites when none are named |
| `observatory deploy [<site>…] [--local] [--skip-build] [--dry-run] [--prune] [--no-worker]` | Builds, uploads each site, then runs `wrangler deploy` in `cloudflare.worker` |
| `observatory check` | Checks the config and each site's Framework config; prints each site's access, warehouse, bucket folder and nested sites |

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
clear those outputs, so every build reads the warehouse again. `dev` doesn't. To see new
data in a running preview, delete `src/.observablehq/cache/data`.

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
