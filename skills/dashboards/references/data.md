# Data: the warehouse, loaders and analytics SQL

## Contents

- Looking at a warehouse
- Loaders
- The `analytics/` folder (warehouses made by fhir-pipes)
- When the data a page needs is not there
- Keeping files small

## Looking at a warehouse

A warehouse folder holds:

```
parquet/<table>/<partition>=<value>/…/*.parquet    one folder per table, often partitioned (country=NGA/)
tiles/*.pmtiles                                     map tiles, when the project has maps
manifest.json                                       when it was refreshed, and each table's row count
```

`observatory dev <site>` and `observatory build <site>` set the environment variable `DATA`
to this folder and print it (`== main: data from …`). `manifest.json` there has
`refreshed_at`, the time of the data.

`observatory pull <site>` copies a warehouse from R2 to
`~/.cache/observatory/warehouses/<rclone remote>/<bucket>/<folder>`, where the folder is the
warehouse's `r2` prefix, or `@root` when the prefix is empty: for example
`~/.cache/observatory/warehouses/r2/icr/@root`. Other warehouses of the project are folders
beside it. Read only the warehouse of the site you are working on; another site's may hold
data with different access rules. A warehouse with a `local` entry in
`observatory.config.js` also has a copy in the repo, used with `--local`.

Read a table with a glob that starts at the first partition folder, so files the producer
keeps beside the data are skipped. (A site's loaders may use a plainer glob such as
`<table>/**/*.parquet`; both read the same rows when nothing else is in the folder.)

```bash
W=<the warehouse folder>/parquet
T() { echo "read_parquet('$W/$1/*=*/**/*.parquet', hive_partitioning=true, union_by_name=true)"; }

ls "$W"                                                       # the tables
duckdb -c "DESCRIBE SELECT * FROM $(T coverage)"              # columns and types
duckdb -c "SELECT count(*) FROM $(T coverage)"
duckdb -c "SELECT * FROM $(T coverage) LIMIT 5"
duckdb -c "SELECT source, lineage, count(*) FROM $(T coverage) GROUP BY ALL ORDER BY 3 DESC"   # the kinds of row
```

Before using a table, answer three questions with queries like these:

1. **What is one row?** A campaign, a report on a campaign, a place in a year? Find the
   columns that together identify a row and check with
   `SELECT <columns>, count(*) FROM … GROUP BY ALL HAVING count(*) > 1`.
2. **Which columns split the rows into kinds that must not be added together?** Typical ones:
   an admin level (a region's row beside its districts' rows), a source (an administrative
   report beside a survey), a status or version (a provisional figure beside the final one), a
   measure name. List the values of each. A total needs one value chosen for each of them.
3. **What is missing?** Count the NULLs in the columns you will chart, and the units with no
   row at all.

If the project documents its tables (a README beside the warehouse, a data dictionary, an
implementation guide), read that too. Column meanings there beat guesses from the names.

## Loaders

A loader is an executable file in `src/data/` whose name is the file it makes plus the
script's extension: `src/data/coverage.parquet.sh` makes `data/coverage.parquet`. Framework
runs it at build time and saves what it prints to standard output.

```bash
#!/usr/bin/env bash
# One row per district and year: people targeted and reached in the reported rounds.
# Read by coverage.md.
set -euo pipefail
W="${DATA:?run with observatory dev or observatory build, which set DATA}/parquet"
T() { echo "read_parquet('$W/$1/*=*/**/*.parquet', hive_partitioning=true, union_by_name=true)"; }
DUCKDB_AGENT_MODE=0 duckdb -c "
COPY (
  SELECT district_id, district, region, year,
         sum(targeted) AS targeted, sum(reached) AS reached
  FROM $(T campaigns)
  WHERE level = 'district'
  GROUP BY ALL
  ORDER BY region, district, year
) TO '/dev/stdout' (FORMAT PARQUET);"
```

- **Start with a comment** saying what one row is and which pages read the file. The next
  person, or agent, decides from it whether to reuse the loader.
- **Make it executable**: `chmod +x`.
- **Follow the site's existing loaders.** Some sites read `DATA` with a fallback to a local
  folder, or share a helper script. Copy the pattern already in `src/data/`.
- **Sort the output.** Sorted parquet compresses better, and a stable order keeps the built
  file's name the same when the data has not changed.
- **Print only the file.** Anything else on standard output corrupts it. Send messages to
  standard error. DuckDB's CLI prints a banner when it detects an agent; `observatory` turns
  that off for loaders it runs, and `DUCKDB_AGENT_MODE=0` does the same when you run one
  yourself.
- **Other outputs work the same way**: `.json.sh`, `.csv.sh`, `.geojson.sh`, `.pmtiles.sh`
  (often just `cat "$DATA/tiles/admin.pmtiles"`).
- **Test a loader alone** before using it in a page:
  `DATA=<warehouse folder> ./src/data/coverage.parquet.sh > /tmp/c.parquet && duckdb -c "FROM '/tmp/c.parquet' LIMIT 5"`.
- **A file is in the build only if a page names it literally**: in the page's `sql:` front
  matter or as `FileAttachment("data/coverage.parquet")`. A path built from a variable is
  not found.
- **The output is cached** in `src/.observablehq/cache/` until the loader file changes.
  Delete that folder after the warehouse changes during `dev`.

## The `analytics/` folder (warehouses made by fhir-pipes)

Some projects keep a site's shared SQL in `analytics/` beside `src/`, as pairs of files:

```
analytics/MainCampaigns.sql     the query
analytics/MainCampaigns.toml    its name, description, and the tables it reads
```

```toml
url = "https://example.org/main/Library/MainCampaigns"
name = "MainCampaigns"
version = "0.1.0"
status = "draft"
kind = "SQLQuery"            # or "SQLView"
title = "Campaigns with their targets and results"
description = """One row per campaign: …"""

[[depends_on]]
label = "calendar"           # the table name the SQL uses
resource = "https://example.org/ViewDefinition/CampaignCalendar"   # what it stands for
```

These are SQL on FHIR Libraries. The tool that refreshes the warehouse (fhir-pipes) runs them
after it has made the base tables:

- A **SQLQuery**'s result is written to the warehouse as a table named after it in snake case:
  `MainCampaigns` becomes `parquet/main_campaigns/`. The site's loader for it only copies the
  table (`SELECT * FROM … ORDER BY …`).
- A **SQLView** is not written anywhere. Other Libraries read it by a `depends_on` entry.

What follows from this:

- **Read the `.sql` and its header comment to learn what a table means.** A dashboard table
  such as `main_campaigns` is defined there, including which reports it keeps and how labels
  are assigned.
- **A change to a Library does not show until the warehouse is refreshed.** Editing the
  `.sql` and reloading the preview changes nothing. The project's runbook has the refresh
  command (often a mode that reruns only the Libraries). Refreshing writes to the shared
  warehouse, so ask before doing it.
- **Add a column to the Library** when a page needs one from the base tables, and keep the
  loader a plain copy. Add a new Library when several pages or outside users need a new
  shared table.
- **Use a loader, not a Library**, for something only one page needs and that is a simple
  shaping of existing tables. It takes effect on the next build.
- **Keep the description and `depends_on` true** when the SQL changes. Other tools list these
  Libraries and show the description to people choosing a query.

A project without an `analytics/` folder puts all of its SQL in loaders.

## When the data a page needs is not there

Work from the page backwards and stop at the first step that has the data:

1. An existing file in `src/data/` already has it: use it.
2. A warehouse table has it: add or extend a loader.
3. The warehouse's base tables have the parts: add a column or a Library in `analytics/`
   (then a refresh), or do the join in a loader.
4. The warehouse does not have it: say so, and say what would have to be added upstream.
   Do not put made-up or hand-typed figures in a page to fill the gap. A small reference
   file that really is static (a list of labels, a published target) can live in `src/data/`
   as a `.csv` or `.json`, with a comment in the page saying where it came from.

## Keeping files small

The browser downloads every file a page names before it draws anything.

- Aggregate to the grain the page shows. A page of districts by year does not need one row
  per household visit.
- Select only the columns pages use.
- Aim for files of a few megabytes or less. For a large point layer, use map tiles instead
  of a parquet of coordinates (see `maps.md`).
- One loader can serve several pages. Name it for what a row is (`campaigns`, `admin_units`),
  not for a page.
