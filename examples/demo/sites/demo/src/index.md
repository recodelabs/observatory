---
title: Overview
sql:
  tables: data/tables.parquet
---

# Overview

```js
const manifest = FileAttachment("data/manifest.json").json();
```

The warehouse was refreshed ${new Date(manifest.refreshed_at).toLocaleString("en-GB", {dateStyle: "long", timeStyle: "short"})}.

```sql id=tables
SELECT table_name AS "Table", rows AS "Rows", columns AS "Columns" FROM tables ORDER BY table_name
```

```js
Inputs.table(tables, {rows: 20})
```

Edit `src/index.md` to start the dashboard, and add a loader in `src/data/` for each table it needs.
