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
| `regionField` | `"admin1_name"` | the unit property that names its region |
| `bounds` | the PMTiles header's | `[[west, south], [east, north]]` to start at |
| `choropleth` | `true` | `false` outlines the units, and a click selects one (a registry view) |
| `labels` | `[]` | `{id, name, lon, lat}` points to label, such as region names |
| `height` | `520` | in pixels |
| `basemap` | OpenStreetMap | `{tiles, attribution}` raster tiles, or `null` |

Methods on the returned element:

- `setValues(Map(id → number), {thresholds, colors, label, format, legendFormat, describe})`
  colours the units and draws a legend. `describe(id, value)` returns the tooltip's HTML.
- `setRegion(name | null)` shows one region's units.
- `fit(bounds?)` zooms to the bounds given, or back to the start.
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
