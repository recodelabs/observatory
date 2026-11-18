---
name: dashboards
description: Write and change dashboard pages in an Observatory project (Observable Framework sites that read a parquet warehouse, built with the `observatory` CLI). Use this whenever the work touches a folder with `observatory.config.js`, a site's `src/*.md` pages, its `src/data/` loaders or its `analytics/` SQL, or when someone asks for a dashboard, a page, a chart, a map, a KPI, a filter or a table on an Observatory site, even if they only say "add a page showing X" or "make a dashboard from this data". Covers where a calculation belongs, how pages are laid out, the chart, colour, number and wording preferences, and how to check a page before calling it done. Not for installing Observatory, deploying, or the sign-in gate.
---

# Writing Observatory dashboards

An Observatory project holds one or more **sites**. A site is an Observable Framework
project: each page is a Markdown file with JavaScript and SQL blocks. The data is a
**warehouse**: a folder of parquet tables (and map tiles) that something else produces. The
site is built into static files, and the browser runs DuckDB over small parquet files that
the build made from the warehouse. No server answers queries while people browse.

Read `observatory.config.js` at the project root first. It names the sites, the folder of
each, and the warehouse each one reads. `npx observatory check` prints the same as a table.

## How data reaches a page

```
warehouse (parquet tables)                produced outside the site
   │  analytics/*.sql  (optional)         SQL run when the warehouse is refreshed; result is a new warehouse table
   ▼
src/data/<name>.parquet.sh                a loader: runs at build time, writes one file the page needs
   ▼
src/<page>.md                             SQL in the browser over those files, then charts
```

Each step has a job. Putting a calculation in the wrong one is the most common mistake.

| Where | Put here | Why |
|---|---|---|
| `analytics/<Name>.sql` | Joins and business rules that several pages or other tools share: which report counts, how a programme is labelled, what "current" means | The rule is written once, and the result is a warehouse table that people can also query outside the dashboard. Changing it needs a warehouse refresh. Only some projects have this folder; see `references/data.md` |
| `src/data/*.sh` loader | Shaping a table for one site: pick columns, drop rows the pages never show, aggregate to the grain the page needs, sort | The browser downloads the loader's whole output, so it should hold only what pages use |
| SQL in the page | What depends on the reader's choices: filters, the selected year, a drill-down | It runs in the browser, on data already downloaded |
| JavaScript in the page | Roll-ups that follow a filter, text for labels and tooltips, chart definitions | |

If a figure appears on more than one page, compute it once upstream (loader or analytics SQL)
so the pages cannot disagree.

## Steps for a new page or chart

1. **Look at the data before writing anything.** Find the warehouse folder (`observatory dev`
   prints `data from <folder>`; cached copies are under `~/.cache/observatory/warehouses/`, see
   `references/data.md` for the layout)
   and query it with the `duckdb` CLI: which tables exist, their columns, how many rows, what
   values the columns you will filter and group by take, and what one row means. Most wrong
   charts come from a wrong guess about what a row is. `references/data.md` has the queries.
2. **Say what the page is for.** One or two sentences: who reads it and what question it
   answers. That decides the filters and the first row of numbers. If the request is vague,
   read a neighbouring page of the same site and follow its structure.
3. **Check the figures by hand.** Compute the page's main numbers with `duckdb` first. Keep
   them: the finished page must show the same numbers.
4. **Write or reuse loaders.** Reuse an existing file in `src/data/` when it has what you
   need. Otherwise add a loader (see `references/data.md`).
5. **Write the page**, following the layout below and `references/page-patterns.md`.
6. **Add the page to the sidebar**: `pages` in the site's `observablehq.config.js`.
7. **Check it** (next section).

When changing an existing page, read the whole page first. Blocks depend on each other
through variable names, and a page usually has its own formatters and colour constants that
new code should reuse.

## Check a page before calling it done

A page can build without errors and still show an empty chart, so look at it.

```bash
npx observatory dev <site> --no-open --port 3000    # keep it running in the background
```

- Add `--local` to read the warehouse's local copy instead of the cached one from R2.
- With CLI 0.3 or later, add `--no-edit` to run the preview without the page editor beside
  it. Earlier versions fail on that option (`npx observatory --version`).
- The first run builds the whole site once and can take a few minutes. Wait for the line
  `↳ http://127.0.0.1:3000/` before opening a page.

- **Open the page** at `http://127.0.0.1:3000/<page>` with a browser tool if you have one, and
  take a screenshot (save it where the browser tool allows, then move it). Read the browser
  console: a failed block shows as a red box on the page
  and an error in the console, not in the terminal.
- **Compare the numbers** with the ones from step 3.
- **Try the filters**: the default selection, "All", and a selection with little data. No
  selection should leave an empty page or `NaN`, `undefined` or `null` on screen.
- **Check a wide and a narrow window**: nothing should overflow or overlap, and charts should
  fill their cards (see the patterns file).
- Without a browser tool, run `npx observatory build <site>` (it fails on a broken loader or a
  missing file), say that the page was built but not seen, and ask the person to look.

A loader's output is cached and is rerun only when the loader file changes. After the
warehouse changes, delete `src/.observablehq/cache/` in the site or edit the loader.
`observatory build` clears it for you.

Leave committing and deploying to the person unless they ask. `observatory deploy` publishes
to the live site.

## How a page is laid out

Pages in a site should look alike. Top to bottom:

1. **Title and one or two sentences** saying what the page shows and where the figures come
   from.
2. **Filters** in one row, each with a sensible default (the latest complete year, all
   units). Give a filter an "All" choice only when the figures can be added across its
   values: leave "All years" out when it would add the same people once per year.
3. **A row of three or four key figures** in cards: a short label, a large number, and a muted
   line saying what the number covers (the selection, the denominator, how many units).
4. **Maps and charts** in cards, two to a row on a wide screen. Each card's title says what it
   shows and for which selection.
5. **A table** with the rows behind the charts, searchable and sortable.
6. **Notes at the foot**: definitions, sources, and what the figures leave out.

Everything below the filters follows them. If something does not (a trend that ignores the
year filter), its title says what it covers. A selection with no data shows a sentence
saying so, not empty axes. Two charts to a row on a wide screen.

## Chart, colour, number and wording preferences

These are the standing preferences for Observatory dashboards. When someone corrects a chart
or states a preference that should hold for later pages, add it to this section with the
reason. A project can add its own in a skill or `CLAUDE.md`; where they differ, the
project's wins.

### Figures

- **A rate is a sum over a sum.** Coverage for a region is the people reached in its
  districts over the people targeted in them. The average of the districts' percentages
  weights a district of 5,000 the same as one of 500,000 and is usually a different number.
- **Compute a rate over rows that have both parts.** If only 14 of 20 rounds have a report,
  the denominator is the target of those 14. Say so beside the figure.
- **Add only rows of one kind.** Before a total, check which columns make rows overlap: an
  admin level (a region and its districts), a data source (a report and a survey), a version
  (provisional and final), an overlapping group (all ages and under-fives). Choose one value
  of each, or show them side by side.
- **A total that counts something twice says so.** Summing targets over campaigns counts a
  person targeted twice. That can be the right figure for workload; the note at the foot
  says what it means.
- **A value over 100% is shown as it is**, with a note on the likely cause (a denominator
  that is too low). Do not cap it.
- **The page's numbers match the source.** Check the headline figures against a direct query
  of the warehouse before finishing.

### Missing data

- **Missing is not zero.** A unit with no report is grey and labelled "no report". Leaving it
  out hides the gap, and zero says something false.
- **Count what is missing** in a key-figure card or beside the chart ("6 rounds not
  reported").
- **Separate the reasons** when the data has them: not due yet, in progress, not reported.

### Choosing a chart

- **A trend over time:** bars for counts by period, lines for a rate. Keep every period on
  the axis, with a gap where there is no data.
- **Comparing units on one measure:** horizontal bars, sorted by value, with the target as a
  line.
- **Units by period:** a heat-map with the value written in each cell.
- **Where:** a choropleth of a rate. Pair it with a table, since small units are hard to see
  and to hover.
- **Planned against done:** a wide pale bar for the plan with a narrower dark bar for the
  result inside it.
- **A part of a whole:** a stacked bar. No pie or donut charts.
- **Two measures with different units** go in two charts side by side, not on two y-axes.
- **Every chart has a table behind it** on the page, so a reader can find an exact number.
- No 3D, no gauges, no decoration that carries no data.

### Colour

- **One meaning per colour within a site.** A programme, a status or a source has the same
  colour on every page. Define them once in a shared component file.
- **Fixed classes for a measure with a target**, the same on every page and under every
  filter, so a reader learns that dark green means "at or above 95%". Reds below the lower
  target, greens from it upwards.
- **Use the programme's own target when it has one**, and name it in the chart ("the dashed
  line is the 65% target"). If the site's classes were made for a different target, so
  that nearly every unit lands in one class, say so and ask which target to use.
- **Quantile classes for a measure with no target**, in one hue from light to dark.
- **A diverging palette only for a difference from a reference**, with the neutral colour on
  the reference.
- **Grey for no data** and for context (a plan behind a result, units outside the selection).
- **Red text is for a problem the reader should act on** ("6 not reported", "3 below 80%").
- **Check colours in the page's theme**: use the theme's variables for text and lines.
- Never rely on colour alone: write the value in the cell or the tooltip.

### Numbers

- Whole numbers with thousands separators: 1,204,318.
- Compact on axes: 1.2M, 340k.
- Percentages without decimals (72%), unless values are close together and the decimal is
  what the reader compares.
- An em dash for "no value". Never `NaN`, `null` or `undefined`.
- Years as 2025, not 2,025.
- A survey estimate with its interval: 81% (76–86).
- Dates as 7 Sep 2026.

### Words

- **A title names the measure, the unit and the selection:** "Administrative coverage by
  LGA, 2025". Titles follow the filters.
- **No slogans, questions or cleverness in headings.** "Coverage by state", not "How are we
  doing?".
- **Don't describe the page.** No "This dashboard shows…" or "Use the filters above to…".
  Say the thing: "People reached by each campaign against the plan."
- **Use the readers' terms** and the project's names for places and programmes. Explain a
  technical term once, in the notes at the foot.
- **Column headers are words**, not column names: "State", not `admin1_name`.
- **Tooltips:** the unit's name first, then the value with its unit of measure, then the
  numbers it was made from.
- **Notes at the foot** give definitions, sources and limits. Keep them short and factual.

## Reference files

- `references/data.md`: looking at a warehouse, writing loaders, the `analytics/` SQL folder,
  and what to do when the data a page needs is not there. Read it before adding data.
- `references/page-patterns.md`: working code for the front matter, filters, key figures,
  charts, tables and notes. Read it before writing a page.
- `references/maps.md`: `adminMap`, class breaks and colours, map tiles. Read it before
  adding a map.
