# Observatory

Observatory publishes [Observable Framework](https://observablehq.com/framework/) dashboards
built on a data warehouse, on Cloudflare.

- **The warehouse:** parquet tables and map tiles in R2.
- **The dashboards:** static Framework sites, built from the warehouse.
- **The browser:** DuckDB-WASM queries each page's data.
- **The gate:** a Worker that serves the sites and decides who sees what. People sign in
  with Keycloak, or by email.

Observatory started from the ICR's Campaign Dashboards (recodelabs/icr) and from doorman,
the login Worker, which it absorbs as `packages/gate`.

**Status: early.** The design is in [docs/spec.md](docs/spec.md).

| Package | State |
|---|---|
| `packages/gate` | doorman v0.2, unchanged so far: email and magic-link sign-in, admin approval, public/protected/disabled rules, one site per Worker. 67 tests pass. |
| `packages/cli` | planned (phase 2) |
| `packages/components` | planned (phase 2) |
| `packages/editor` | planned (phase 5) |

## Develop

Needs Node 22 or later (`.node-version`).

```bash
npm install
npm test --workspace packages/gate
```

See `packages/gate/README.md` for running the gate locally with wrangler.
