# Maps

Maps are drawn with MapLibre from PMTiles: one file of vector tiles that the page reads
without a tile server. The tiles come from the warehouse (`tiles/*.pmtiles`), through a
loader that copies the file:

```bash
#!/usr/bin/env bash
# Admin boundary tiles from the warehouse.
set -euo pipefail
cat "${DATA:?}/tiles/admin.pmtiles"
```

## Check the site first

Many sites have their own map component in `src/components/` (a map with the site's layer
names, colours and tooltips, or two maps that pan together). If the site has one, use it and
follow how a neighbouring page calls it. Use `adminMap` from the components package for a
new site or a simple choropleth.

A site's component may write its own legend and tooltip text. Use the same term for the
measure in the card title and notes as the component uses, or change the component so the
text can be passed in. Two names for one measure on a page read as two measures.

## adminMap

```html
<link rel="stylesheet" href="npm:maplibre-gl@5/dist/maplibre-gl.css">
```

```js
import {adminMap, quantileBreaks, colorsFor} from "@recodelabs/observatory-components";
const tiles = await FileAttachment("data/admin.pmtiles").arrayBuffer();
const map = adminMap({pmtiles: tiles, height: 440});
```

```js
// A separate cell, so a filter change recolours the map without rebuilding it.
const values = new Map(yearRows.map((d) => [d.district_id, d.targeted]));
const breaks = quantileBreaks([...values.values()]);
map.setValues(values, {
  thresholds: breaks, colors: colorsFor(breaks), label: "People targeted", format: fmtInt,
  describe: (id, v) => `<b>${names.get(id) ?? id}</b><br>${v == null ? "no data" : fmtInt(v) + " targeted"}`
});
```

Place it in a card: `<div class="card" style="padding: 0; overflow: hidden"><div class="map-title">People targeted by district, ${year}</div>${map}</div>`.

- **The keys of the Map must be the tile features' ids.** Check what the id is (usually the
  unit's id in the warehouse's location table) before joining. If the map draws but stays
  uncoloured, the ids do not match.
- **`layers`** names the tile layers for units, regions and country. The default is
  `{units: "lgas", regions: "states", country: "country"}`. Look at how the site's other
  pages set it, or read the layer names from the tiles, before assuming.
- **`levels`** is for a map that switches between admin levels, with one tile layer per
  level: `adminMap({pmtiles, levels: {2: "admin2", 3: "admin3"}})`, then
  `setValues(values, {level: 3, …})`. Needs components 0.4.
- **Build the map once and update it.** Creating the map in a cell that reads a filter
  rebuilds it on every change, and the reader loses their zoom.
- `setRegion(name | null)` shows one region's units; `fit(bounds?)` zooms; `map.map` is the
  MapLibre map; `Generators.input(map)` gives the clicked unit as `{id, properties}`.
- `choropleth: false` draws outlines only, for a map whose purpose is choosing a unit.
- `labels: [{id, name, lon, lat}]` adds names, such as region labels.

The package's README has the full option table.

## Classes and colours

- **A measure with a target** (coverage, completion): fixed breaks around the target, the
  same on every page of the site, with a legend. Define the breaks and colours once in a
  shared component file. `SKILL.md` has the colour preferences.
- **A measure with no target** (population, counts): `quantileBreaks(values)` with
  `colorsFor(breaks)`, which uses a one-hue palette, light to dark. Say in the map title
  that the classes follow the selection, if they change with the filters.
- **A difference from a reference** (above or below last year, or a plan): the `DIVERGING`
  palette, with the middle class on the reference.
- **No data** is light grey and named in the legend or tooltip. It is not the lowest class.
- Five to seven classes. More cannot be told apart on a map.

## Counts on a map

A choropleth of raw counts mostly shows which units are large. Prefer a rate (per person,
per target) for comparing units, and keep counts for the table, or say plainly in the title
that the map shows totals.

## Large point layers

Points in their thousands (facilities, settlements) belong in a PMTiles file that the page
reads by HTTP range request, not in a parquet of coordinates: only the tiles in view are
downloaded. That needs a tile file in the warehouse. If there is none, say so and do not
load every point into the page.
