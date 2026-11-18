# Page patterns

Working code for the parts of a page, in the order they appear. Take the shape, and use the
site's own names, formatters and colours where a neighbouring page already defines them.

## Contents

- How a page runs
- Front matter and tables
- Helpers at the top
- Filters
- Linked filters
- Querying for the selection
- Key figures
- Charts
- Tables
- Notes at the foot
- Styles
- Things that go wrong

## How a page runs

A page is Markdown. A fenced `js` block is a cell: its top-level variables can be used in
any other block and in `${…}` in the text. Cells run in dependency order, not top to bottom,
and a cell reruns when something it reads changes. So a filter's value is just a variable,
and every cell that reads it follows the filter.

- A cell that is one expression is displayed. A cell with statements displays only what it
  passes to `display(…)` or places in the text with `${name}`.
- Define a chart in a cell (`const chart = Plot.plot(…)`) and place it in the HTML layout with
  `${chart}`. That keeps layout in HTML and logic in cells.
- A name can be defined in only one cell on a page.
- Wrap side effects in a block (`{ … }`) so they define no names.

## Front matter and tables

```md
---
title: Campaign coverage
sql:
  campaigns: data/campaigns.parquet
  admin_units: data/admin_units.parquet
---
```

Each `sql:` entry is a table for the page's SQL, in the browser. Query it from JavaScript
with the `sql` tag, or with a fenced `sql` block when the result goes straight to a table:

````md
```js
const years = toRows(await sql`SELECT DISTINCT year FROM campaigns ORDER BY year`).map((d) => d.year);
```

```sql id=byRegion
SELECT region, sum(targeted) AS targeted FROM campaigns GROUP BY 1 ORDER BY 1
```
````

Files that are not tables are read with `FileAttachment("data/manifest.json").json()`,
`.arrayBuffer()` and so on. The path must be a literal string.

## Helpers at the top

DuckDB returns Arrow rows, and whole numbers from `count` and `sum` come back as BigInt,
which breaks arithmetic and charts. Convert once:

```js
const toRows = (table) => Array.from(table, (r) => {
  const o = typeof r.toJSON === "function" ? r.toJSON() : {...r};
  for (const k in o) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
  return o;
});
const fmtInt = (n) => n == null ? "—" : Math.round(Number(n)).toLocaleString("en");
const fmtPct = (x) => x == null ? "—" : `${Math.round(x * 100)}%`;
const fmtCompact = (v) => v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v));
```

If several pages of a site need the same helpers or colours, put them in
`src/components/<name>.js` and import them (`import {fmtInt} from "./components/format.js";`).

## Filters

Create the input, show it in the layout, and read its value as a variable:

````md
<div class="grid grid-cols-3" style="gap: 12px; margin-bottom: 8px">
  <div>${programmeInput}</div>
  <div>${yearInput}</div>
  <div>${regionInput}</div>
</div>

```js
const programmeData = ["All", ...programmes], yearData = ["All", ...years], regionData = ["All", ...regions];
const programmeInput = Inputs.select(programmeData, {label: "Programme", value: "All"});
const programme = Generators.input(programmeInput);
const yearInput = Inputs.select(yearData, {label: "Year", value: years.at(-1), format: String});
const year = Generators.input(yearInput);
const regionInput = Inputs.select(regionData, {label: "Region", value: "All"});
const region = Generators.input(regionInput);
```
````

`view(Inputs.select(…))` is the short form when the input can sit where the cell is.

## Linked filters

With several filters, a reader can pick a combination that has no data. The components
package greys out the choices that would be empty:

```js
import {constrain, available} from "@recodelabs/observatory-components/filters";
const combos = toRows(await sql`SELECT year, region, programme, count(*) AS n FROM campaigns GROUP BY ALL`);
```

```js
{
  constrain(programmeInput, programmeData, available(combos, "programme", {year, region}));
  constrain(yearInput, yearData, available(combos, "year", {programme, region}));
  constrain(regionInput, regionData, available(combos, "region", {programme, year}));
}
```

`matching(combos, filters)` returns the rows that match every filter ("All" matches
anything). `checkboxSelect(options, {label})` is a pull-down with checkboxes for choosing
several values.

## Querying for the selection

Filter in SQL when the table is large, in JavaScript when the rows are already loaded.

A `${…}` inside the `sql` tag is passed to DuckDB as a parameter, so it needs no quoting or
escaping. Use this form whenever the query's shape is fixed:

```js
const rows = toRows(await sql`SELECT * FROM campaigns WHERE programme = ${programme} AND year = ${year}`);
```

Build the text yourself only when the conditions change with the selection, such as an "All"
choice that drops a condition:

```js
const esc = (s) => String(s).replace(/'/g, "''");
const where = [
  programme === "All" ? "TRUE" : `programme = '${esc(programme)}'`,
  region === "All" ? "TRUE" : `region = '${esc(region)}'`
].join(" AND ");
// sql([text]) runs a query built as a string.
const allRows = toRows(await sql([`SELECT * FROM campaigns WHERE ${where} ORDER BY year, region`]));
const yearRows = year === "All" ? allRows : allRows.filter((d) => d.year === Number(year));
```

Keep the rows for all years when a chart shows a trend, and apply the year filter separately
to the key figures and maps. A trend chart that collapses to one bar when a year is picked
tells the reader nothing.

## Key figures

Compute them in one cell, from the same rows the charts use, so they cannot disagree:

````md
```js
const reported = yearRows.filter((d) => d.reached != null);
const kpi = {
  units: new Set(yearRows.map((d) => d.district_id)).size,
  targeted: d3.sum(yearRows, (d) => d.targeted),
  reached: d3.sum(reported, (d) => d.reached),
  reportedTargeted: d3.sum(reported, (d) => d.targeted),
  noReport: yearRows.length - reported.length
};
// A rate is a sum over a sum, over the rows that have both parts.
kpi.coverage = kpi.reportedTargeted > 0 ? kpi.reached / kpi.reportedTargeted : null;
const scope = `${programme === "All" ? "all programmes" : programme} · ${region === "All" ? "all regions" : region} · ${year === "All" ? "all years" : year}`;
```

<div class="grid grid-cols-4" style="gap: 12px">
  <div class="card"><h2>People targeted</h2><span class="big">${fmtInt(kpi.targeted)}</span>
    <div class="muted">${fmtInt(kpi.units)} districts · ${scope}</div></div>
  <div class="card"><h2>People reached</h2><span class="big">${fmtInt(kpi.reached)}</span>
    <div class="muted">of ${fmtInt(kpi.reportedTargeted)} targeted in the reported rounds</div></div>
  <div class="card"><h2>Coverage</h2><span class="big">${fmtPct(kpi.coverage)}</span>
    <div class="muted">people reached ÷ people targeted</div></div>
  <div class="card"><h2>Not reported</h2><span class="big">${fmtInt(kpi.noReport)}</span>
    <div class="muted">of ${fmtInt(yearRows.length)} rounds</div></div>
</div>
````

The muted line under each number says what it covers. Without it a reader cannot tell
whether "1.2M" is this year, this region, or everything.

Framework's grid wraps: four cards show as two rows of two when the page is narrower, for
example with the sidebar open on a laptop. That is expected. Write each card so it reads on
its own.

## Charts

Use Observable Plot (`Plot` is available without an import). Give the chart the width of
its card with `resize`, which redraws it when the card's width changes, including when a
two-column grid becomes one column on a narrow screen:

```html
<div class="card"><h2>Coverage by region, ${year}, highest first</h2>
  ${resize((width) => regionBars(width))}
</div>
```

```js
// Horizontal bars for comparing units on one measure: sorted, a value at the end of each bar,
// the target as a line, and units with no value named instead of dropped.
const TARGET = 0.8;
function regionBars(width) {
  const rows = d3.sort(byRegion, (d) => -(d.coverage ?? -1));
  const has = rows.filter((d) => d.coverage != null), none = rows.filter((d) => d.coverage == null);
  return Plot.plot({
    width, height: 40 + 30 * rows.length, marginLeft: 110,
    x: {label: null, domain: [0, 1.25], ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], tickFormat: fmtPct, grid: true},  // room for the labels
    y: {label: null, domain: rows.map((d) => d.region)},
    color: {type: "threshold", domain: COVERAGE_BREAKS, range: COVERAGE_COLORS},   // the same classes as the map
    marks: [
      Plot.barX(has, {y: "region", x: "coverage", fill: "coverage", tip: true,
        title: (d) => `${d.region}\ncoverage: ${fmtPct(d.coverage)}\n${fmtInt(d.reached)} reached of ${fmtInt(d.targeted)} targeted`}),
      Plot.ruleX([TARGET], {stroke: "#b91c1c", strokeDasharray: "3,3"}),              // before the labels, so they sit on top
      Plot.text(has, {y: "region", x: "coverage", dx: 5, textAnchor: "start", fontSize: 11,
        stroke: "var(--theme-background-alt)", strokeWidth: 4, fill: "currentColor",
        text: (d) => `${fmtPct(d.coverage)} · ${fmtInt(d.reached)} of ${fmtInt(d.targeted)}`}),
      Plot.text(none, {y: "region", x: 0, dx: 5, textAnchor: "start", fontSize: 11, fill: "#94a3b8", text: () => "no report"}),
      Plot.ruleX([0])
    ]
  });
}
```

Many existing pages size a chart from the page instead, which is fine on a wide screen but
leaves the chart at half width when the grid becomes one column:

````md
<div class="grid grid-cols-2" style="gap: 12px; margin-top: 12px">
  <div class="card"><h2>People targeted and reached by year${region === "All" ? "" : `, ${region}`}</h2>${peoplePlot}</div>
  <div class="card"><h2>Coverage by district and year</h2>${heatmap}</div>
</div>

```js
const peoplePlot = Plot.plot({
  width: Math.max(320, width / 2 - 40),      // `width` is the page's width and updates on resize
  height: 300, marginLeft: 50,
  x: {label: null, tickFormat: String},
  y: {label: "people", grid: true, tickFormat: fmtCompact},
  color: {domain: ["targeted", "reached"], range: ["#cbd5e1", "#238b45"], legend: true},
  marks: [
    Plot.barY(byYear, {x: "year", y: "targeted", fill: () => "targeted", tip: true,
      title: (d) => `${d.year}\npeople targeted: ${fmtInt(d.targeted)}`}),
    Plot.barY(byYear, {x: "year", y: "reached", fill: () => "reached", insetLeft: 3, insetRight: 3, tip: true,
      title: (d) => `${d.year}\npeople reached: ${fmtInt(d.reached)}`}),
    Plot.ruleY([0])
  ]
});
```
````

A heat-map of units by period, with fixed classes and the missing cells drawn in grey:

```js
const COVERAGE_BREAKS = [0.5, 0.65, 0.8, 0.9, 0.95, 1.05];
const COVERAGE_COLORS = ["#fde0dd", "#fcc5c0", "#fa9fb5", "#c7e9c0", "#a1d99b", "#74c476", "#238b45"];
const heatmap = Plot.plot({
  width: Math.max(320, width / 2 - 40),
  height: 60 + 24 * Math.max(4, units.length),          // a row per unit, so labels never overlap
  marginLeft: 110, marginTop: 24,
  x: {label: null, domain: years, tickFormat: String, axis: "top"},
  y: {label: null, domain: units},
  color: {type: "threshold", domain: COVERAGE_BREAKS, range: COVERAGE_COLORS, legend: true,
          tickFormat: (d) => `${Math.round(d * 100)}%`, label: "coverage"},
  marks: [
    Plot.cell(cells.filter((d) => d.coverage == null), {x: "year", y: "unit", fill: "#eef0f3", inset: 1}),
    Plot.cell(cells.filter((d) => d.coverage != null), {x: "year", y: "unit", fill: "coverage", inset: 1, tip: true,
      title: (d) => `${d.unit}, ${d.year}\n${fmtInt(d.reached)} reached of ${fmtInt(d.targeted)} targeted (${fmtPct(d.coverage)})`}),
    Plot.text(cells, {x: "year", y: "unit", fontSize: 11,
      text: (d) => d.coverage != null ? fmtPct(d.coverage) : "no report",
      fill: (d) => d.coverage != null ? "#111" : "#94a3b8"})
  ]
});
```

- Set `domain` on an axis of categories or years, so the axis does not change as filters
  change and a missing year shows as a gap.
- Put a target on a chart with `Plot.ruleY([0.8], {stroke: "#b91c1c", strokeDasharray: "3,3"})`
  and say in the card what the line is.
- Size the height from the number of rows for bar and cell charts with one row per unit.
- Sort bars by value when the order of units has no meaning, and say so in the title
  ("…, highest first").

## Tables

````md
```js
const search = view(Inputs.search(byUnit, {placeholder: "Search district, year…"}));
```

```js
Inputs.table(search, {
  columns: ["year", "unit", "targeted", "reached", "coverage"],
  header: {year: "Year", unit: "District", targeted: "Targeted", reached: "Reached", coverage: "Coverage"},
  format: {year: String, targeted: fmtInt, reached: fmtInt, coverage: fmtPct},
  align: {coverage: "right"},
  rows: 20
})
```
````

Name every column in `header`: raw column names such as `admin1_name` should not reach the
reader. Format years with `String`, or they show as "2,025".

## Notes at the foot

```html
<footer class="muted" style="margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--theme-foreground-faintest); font-size: 12px; line-height: 1.6">
  <p>People targeted is each round's planning figure. People reached and coverage come from the
  reconciled administrative report, so rounds with no report are left out of both.
  Coverage above 100% means the planning figure undercounted the population.</p>
</footer>
```

Say where each figure comes from, what is left out, and any way the totals could mislead
(for example, a person targeted by two campaigns counts twice in a total across programmes).

## Styles

Framework supplies `grid`, `grid-cols-2` to `grid-cols-4`, `card`, `muted`, `small`. Pages add
a small block for the rest, the same on every page of a site:

```html
<style>
.big { font-size: 28px; font-weight: 600; line-height: 1.1; }
.card h2 { font-size: 13px; font-weight: 500; color: var(--theme-foreground-muted); margin: 0 0 4px; }
.map-title { font-size: 13px; font-weight: 500; color: var(--theme-foreground-muted); padding: 10px 14px 6px; }
</style>
```

If the site has a `src/style.css`, use its classes and do not repeat them in the page.
Use the theme's colour variables (`var(--theme-foreground-muted)` and so on) for text and
borders, so the page works in a dark theme.

## Things that go wrong

| What you see | Cause |
|---|---|
| "Cannot mix BigInt and other types", or a chart with no marks | A count or sum is a BigInt: pass query results through `toRows` |
| "x is defined more than once" | Two cells define the same name |
| A chart does not follow a filter | The cell reads the input element (`yearInput`) instead of its value (`year`) |
| "File not found" for a data file in the build | The `FileAttachment` path is not a literal string, or the loader is not executable |
| The page shows old data | The loader's output is cached: delete `src/.observablehq/cache/` |
| Years show as "2,025" | Add `tickFormat: String` or `format: String` |
| A filter value with an apostrophe breaks the query | Escape it (`esc` above) |
| The preview shows a table that the SQL says is missing | The name is not in the page's `sql:` front matter |
