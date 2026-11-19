# @recodelabs/observatory-components

Components for Observable Framework pages. Framework bundles them from `node_modules`, so
pages import them by package name:

```js
import {adminMap, quantileBreaks, colorsFor} from "@recodelabs/observatory-components";
```

## adminMap

A map of administrative units on MapLibre, from a PMTiles file that the page loads whole.
It works from any static host.

```html
<link rel="stylesheet" href="npm:maplibre-gl@5/dist/maplibre-gl.css">
```

```js
const tiles = await FileAttachment("data/admin.pmtiles").arrayBuffer();
const map = display(adminMap({pmtiles: tiles, height: 480}));
const breaks = quantileBreaks([...population.values()]);
map.setValues(population, {thresholds: breaks, colors: colorsFor(breaks), label: "Population", format: d3.format(",")});
```

| Option | Default | |
|---|---|---|
| `pmtiles` | (required) | an ArrayBuffer of the tiles |
| `layers` | `{units: "lgas", regions: "states", country: "country"}` | the tile layers. These are fhir-pipes' names, used for every country |
| `levels` | none | `{2: "admin2", 3: "admin3"}`: the tile layer of each admin level, for a map that switches between levels. Replaces `layers.units` and `layers.regions` |
| `regionField` | `"admin1_name"` | the unit property that names its region |
| `bounds` | the PMTiles header's | `[[west, south], [east, north]]` to start at |
| `choropleth` | `true` | `false` outlines the units, and a click selects one (a registry view) |
| `noValue` | `"#e5e7eb"` | the colour of a unit with no value. Use a darker grey when the palette's palest class is close to it |
| `labels` | `[]` | `{id, name, lon, lat}` points to label, such as region names |
| `height` | `520` | in pixels |
| `basemap` | OpenStreetMap | `{tiles, attribution}` raster tiles, or `null` |

Methods on the returned element:

- `setValues(Map(id → number), {thresholds, colors, label, format, legendFormat, describe})`
  colours the units and draws a legend. `describe(id, value)` returns the tooltip's HTML.
  With `levels`, add `level` to choose the admin level drawn: its units are coloured and the
  level above is drawn as thicker lines. The layer ids stay `unit-fill` and `unit-line`.
- `setRegion(name | null)` shows one region's units.
- `fit(bounds?)` zooms to the bounds given, or back to the start. The map fits again when its
  container changes size, until the reader moves it.
- `map` is the MapLibre map.
- `value` is the clicked unit's `{id, properties}`. Each click sends an `input` event, so
  `Generators.input(map)` works.

## Choropleth classes

- `quantileBreaks(values, n = 6)`: up to n−1 rounded quantile breaks.
- `colorsFor(breaks, palette = BLUES)`: the darkest `breaks.length + 1` colours of a
  sequential palette.
- `BLUES`: a sequential palette (one hue, light to dark).
- `DIVERGING`: a diverging palette (two hues, with grey in the middle).

## Linked filters

These link several `Inputs.select` controls:

- `constrain(input, data, valid, {keep, fallback, suffix})` greys out the options that
  have no data under the other filters.
- `matching(combos, filters)` returns the rows that match every filter; `"All"` matches
  anything.
- `available(combos, key, filters)` returns the set of `key` values those rows have.
- `checkboxSelect(options, {label, format, value, emptyLabel, fullLabel})` is a closed
  pull-down with checkboxes. It works with `Generators.input`.

## A range filter on a chart

`brushX` turns an Observable Plot chart into a filter: the reader drags across it to pick a
range of the x axis. A chart has no filter unless the page calls `brushX` on it.

```js
import {brushX, within} from "@recodelabs/observatory-components";

const histogram = brushX(Plot.plot({
  x: {label: "Campaign target as % of the routine target →", domain: [20, 200]},
  marks: [Plot.rectY(units, Plot.binX({y: "count"}, {x: "ratio"})), Plot.ruleY([0])]
}));
const range = Generators.input(histogram);   // [low, high], or null for everything
```

```js
const shown = units.filter((d) => within(range, d.ratio, {min: 20, max: 200}));
```

The reader drags to select, drags the selection to move it, drags an edge to resize it, and
clicks outside it or on "Clear" to remove it. Bars outside the selection are faded.

- `brushX(plot, {enabled, value, round, marks, color, clear})` returns the chart it was
  given. `value` is `[low, high]` in x values, or `null`. Each finished drag sends an `input`
  event. `clear()` removes the selection.
  - `enabled: false` leaves the chart as it is, with a value of `null`. Cells that read the
    range keep working, so a page can switch the filter on and off with a checkbox.
  - `value` is a selection to start with. Pass the current range when the chart is redrawn
    to keep it.
  - `round` is applied to each end. By default numbers are rounded to whole values.
  - `marks` is the CSS selector of the marks to fade (default: the chart's bars).
  - `clear` is the text of the control that removes the selection, or `null` for none.
- `within(range, value, {min, max})` tests a value against the range. Name `min` and `max`
  when the first and last bars also hold everything beyond the axis: a range that reaches
  that end then has no limit on that side.

The x scale must be continuous (numbers or dates). Rows of facets (`fy`) share one
selection. Columns of facets (`fx`) are not supported.
