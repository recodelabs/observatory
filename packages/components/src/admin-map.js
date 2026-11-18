// A map of administrative units on MapLibre, from a PMTiles file of boundaries that the page
// loads whole (a FileAttachment's arrayBuffer()), so it works from any static host.
//
// One component for two uses:
//   - a choropleth: setValues(Map(unit id → number), {thresholds, colors, label, format, describe})
//   - a registry view (choropleth: false): units outlined; click one to select it.
// Both: setRegion(name or null) to show one region's units, fit(bounds), and `value` + an
// "input" event with the clicked unit's tile properties, so Generators.input(map) works.
//
// The tiles need three layers: the units that are coloured and clicked, the regions they sit in
// (drawn as thicker lines) and the country outline. fhir-pipes names them `lgas`, `states` and
// `country` for every country, which are the defaults. Each unit needs an `id` (the key of
// setValues), a `name`, and the field that names its region (`regionField`). The map starts at
// the bounds in the PMTiles header unless `bounds` is given.
//
// A map that switches between admin levels (districts, then the units inside them) takes
// `levels` instead: the tile layer of each admin level, {2: "admin2", 3: "admin3"}.
// setValues(values, {level: 3, …}) then colours that level and draws the level above it as the
// thicker lines. The lowest level is outlined until the first setValues.
//
// The page also needs MapLibre's stylesheet:
//   <link rel="stylesheet" href="npm:maplibre-gl@5/dist/maplibre-gl.css">
import maplibregl from "maplibre-gl";
import {PMTiles, Protocol} from "pmtiles";

class BufferSource {
  constructor(buffer, key) { this.buffer = buffer; this.key = key; }
  getKey() { return this.key; }
  async getBytes(offset, length) { return {data: this.buffer.slice(offset, offset + length)}; }
}

const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
// One archive per buffer, so maps that share a buffer share its tiles.
const archives = new WeakMap();
let nextKey = 0;

export const OSM = {tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attribution: "© OpenStreetMap contributors"};
const NO_VALUE = "#e5e7eb";
const LAYERS = {units: "lgas", regions: "states", country: "country"};

export function adminMap({
  pmtiles, layers = {}, levels = null, regionField = "admin1_name", bounds, labels = [], height = 520,
  choropleth = true, noValue = NO_VALUE, basemap = OSM, glyphs = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf"
} = {}) {
  if (!(pmtiles instanceof ArrayBuffer)) throw new Error("adminMap: pmtiles must be an ArrayBuffer (await FileAttachment(…).arrayBuffer())");
  // With `levels`, the unit and region layers follow the level being shown, and there is a
  // country outline only if the page names its layer.
  const L = levels ? {country: null, ...layers} : {...LAYERS, ...layers};
  let level = levels ? Math.min(...Object.keys(levels).map(Number)) : null;
  const unitLayer = () => (levels ? levels[level] : L.units);
  const regionLayer = () => (levels ? levels[level - 1] ?? null : L.regions);
  const container = document.createElement("div");
  container.style.cssText = `width:100%;height:${height}px;border-radius:8px;overflow:hidden;position:relative;background:#f8fafc`;
  let entry = archives.get(pmtiles);
  if (!entry) {
    const key = `obs-admin-${nextKey++}`;
    entry = {key, archive: new PMTiles(new BufferSource(pmtiles, key))};
    protocol.add(entry.archive);
    archives.set(pmtiles, entry);
  }
  const {key, archive} = entry;

  const sources = {
    admin: {type: "vector", url: `pmtiles://${key}`, promoteId: Object.fromEntries((levels ? Object.values(levels) : [L.units, L.regions]).map((l) => [l, "id"]))},
    labels: {type: "geojson", data: {type: "FeatureCollection", features: labels.map((d) => ({
      type: "Feature", id: d.id, properties: {name: d.name}, geometry: {type: "Point", coordinates: [d.lon, d.lat]}}))}}
  };
  // The layers that depend on the level shown. They keep their ids when the level changes, so
  // a page's own handlers on "unit-fill" go on working.
  const levelLayers = () => [
    {id: "unit-fill", type: "fill", source: "admin", "source-layer": unitLayer(),
     paint: choropleth
       ? {"fill-color": noValue, "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.8]}
       : {"fill-color": "#93c5fd", "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.55, ["boolean", ["feature-state", "hover"], false], 0.35, 0.08]}},
    {id: "unit-line", type: "line", source: "admin", "source-layer": unitLayer(), paint: {"line-color": "#94a3b8", "line-width": 0.5}},
    ...(regionLayer() ? [{id: "region-line", type: "line", source: "admin", "source-layer": regionLayer(), paint: {"line-color": "#334155", "line-width": 1.3}}] : [])
  ];
  const layerList = [
    ...levelLayers(),
    ...(L.country ? [{id: "country-line", type: "line", source: "admin", "source-layer": L.country, paint: {"line-color": "#0f172a", "line-width": 2, "line-dasharray": [3, 2]}}] : []),
    {id: "region-label", type: "symbol", source: "labels",
     layout: {"text-field": ["get", "name"], "text-size": 12, "text-font": ["Open Sans Semibold"], "text-allow-overlap": false},
     paint: {"text-color": "#1e293b", "text-halo-color": "#fff", "text-halo-width": 1.5}}
  ];
  if (basemap) {
    sources.basemap = {type: "raster", tiles: basemap.tiles, tileSize: 256, maxzoom: 19, attribution: basemap.attribution};
    layerList.unshift({id: "basemap", type: "raster", source: "basemap", paint: {"raster-opacity": 0.45, "raster-saturation": -0.9}});
  }
  const map = new maplibregl.Map({
    container, style: {version: 8, glyphs, sources, layers: layerList},
    ...(bounds ? {bounds, fitBoundsOptions: {padding: 16}} : {}), attributionControl: {compact: true}
  });

  // The bounds to start at and to return to: the option, or the PMTiles header's.
  let home = bounds ?? null;
  const headerBounds = home ? Promise.resolve(home)
    : archive.getHeader().then((h) => (home = [[h.minLon, h.minLat], [h.maxLon, h.maxLat]]));
  // Fit again whenever the container changes size (a grid settling, a phone turned), until
  // the reader has moved the map themselves.
  let view = home, moved = false;
  map.on("movestart", (e) => { if (e.originalEvent) moved = true; });
  const fitView = () => {
    if (moved || !(view ?? home) || container.clientWidth === 0) return;
    map.fitBounds(view ?? home, {padding: 16, duration: 0});
  };
  headerBounds.then(fitView);
  new ResizeObserver(() => {
    if (container.clientWidth === 0) return;
    map.resize(); fitView();
  }).observe(container);
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-right");
  map.scrollZoom.disable();

  const legend = document.createElement("div");
  legend.style.cssText = "position:absolute;left:8px;bottom:8px;background:rgba(255,255,255,.94);padding:6px 10px;border-radius:6px;font:12px system-ui;color:#334155;box-shadow:0 1px 3px rgba(0,0,0,.15);max-width:calc(100% - 16px)";
  legend.style.display = "none";
  container.appendChild(legend);

  let values = new Map(), opts = {}, ready = false, region = null, selectedId = null;
  const popup = new maplibregl.Popup({closeButton: false, closeOnClick: false, offset: 8});
  let hovered = null;
  const setState = (id, s) => map.setFeatureState({source: "admin", sourceLayer: unitLayer(), id}, s);
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  map.on("mousemove", "unit-fill", (e) => {
    const f = e.features?.[0]; if (!f) return;
    map.getCanvas().style.cursor = "pointer";
    if (hovered !== null && hovered !== f.id) setState(hovered, {hover: false});
    hovered = f.id; setState(hovered, {hover: true});
    const v = values.get(f.id);
    // describe() returns HTML, written by the page; tile properties are escaped.
    const body = opts.describe ? opts.describe(f.id, v)
      : choropleth ? (v == null ? "no value" : `${escape(opts.label)}: ${escape((opts.format ?? String)(v))}`)
      : `<span style="color:#64748b">click to inspect</span>`;
    const in_ = f.properties[regionField];
    const where = in_ && in_ !== f.properties.name ? `, ${escape(in_)}` : "";
    popup.setLngLat(e.lngLat).setHTML(`<div style="font:12px system-ui;line-height:1.4"><b>${escape(f.properties.name)}</b>${where}<br>${body}</div>`).addTo(map);
  });
  map.on("mouseleave", "unit-fill", () => {
    map.getCanvas().style.cursor = "";
    if (hovered !== null) setState(hovered, {hover: false});
    hovered = null; popup.remove();
  });
  map.on("click", "unit-fill", (e) => {
    const f = e.features?.[0]; if (!f) return;
    if (!choropleth) {
      if (selectedId !== null) setState(selectedId, {selected: false});
      selectedId = f.id; setState(selectedId, {selected: true});
    }
    container.value = {id: f.id, properties: f.properties};
    container.dispatchEvent(new Event("input", {bubbles: true}));
  });

  function renderLegend() {
    if (!choropleth || !opts.colors) { legend.style.display = "none"; return; }
    const t = opts.thresholds, c = opts.colors, f = opts.legendFormat ?? opts.format ?? String;
    const swatch = (color) => `<span style="display:inline-block;width:14px;height:11px;background:${color};border:1px solid #cbd5e1"></span>`;
    const items = c.map((color, i) => {
      const text = c.length === 1 ? "with a value"
        : i === 0 ? `< ${f(t[0])}` : i === c.length - 1 ? `≥ ${f(t[i - 1])}` : `${f(t[i - 1])}–${f(t[i])}`;
      return `<div style="display:flex;align-items:center;gap:6px;line-height:1.5">${swatch(color)}${escape(text)}</div>`;
    }).join("");
    legend.innerHTML = `<div style="margin-bottom:3px;font-weight:500">${escape(opts.label)}</div>${items}`
      + `<div style="display:flex;align-items:center;gap:6px;line-height:1.5">${swatch(noValue)}no value</div>`;
    legend.style.display = "";
  }

  // Draw another admin level: the same layer ids, on that level's tile layer.
  function showLevel(next) {
    if (!levels || next == null || next === level) return;
    if (!(next in levels)) throw new Error(`adminMap: no tile layer for level ${next} in levels`);
    if (hovered !== null) setState(hovered, {hover: false});
    if (selectedId !== null) setState(selectedId, {selected: false});
    hovered = selectedId = null; popup.remove();
    for (const id of ["unit-fill", "unit-line", "region-line"]) if (map.getLayer(id)) map.removeLayer(id);
    level = next;
    const before = map.getLayer("country-line") ? "country-line" : "region-label";
    for (const layer of levelLayers()) map.addLayer(layer, before);
  }

  // The colours, filters and legend: set when the page changes something.
  function apply() {
    if (!ready) return;
    showLevel(opts.level);
    if (choropleth && opts.colors) {
      if (opts.colors.length !== opts.thresholds.length + 1) throw new Error("adminMap: colors needs one more entry than thresholds");
      // One class (no thresholds, e.g. every value the same) is one colour; a step needs a stop.
      let color = opts.colors[0];
      if (opts.thresholds.length) {
        color = ["step", ["feature-state", "v"], opts.colors[0]];
        opts.thresholds.forEach((t, i) => color.push(t, opts.colors[i + 1]));
      }
      map.setPaintProperty("unit-fill", "fill-color", ["case", ["==", ["feature-state", "v"], null], noValue, color]);
    }
    const regionFilter = region ? ["==", ["get", regionField], region] : null;
    for (const id of ["unit-fill", "unit-line"]) map.setFilter(id, regionFilter);
    if (map.getLayer("region-line")) map.setFilter("region-line", region ? ["==", ["get", "name"], region] : null);
    map.setFilter("region-label", region ? ["==", ["get", "name"], region] : null);
    renderLegend();
    applyValues();
  }
  // Each unit's value. Feature-state is per loaded tile, so this also runs when tiles arrive.
  // It changes no style property: doing that here would reload the source, and loop.
  function applyValues() {
    if (!ready || !choropleth || !opts.colors) return;
    for (const f of map.querySourceFeatures("admin", {sourceLayer: unitLayer()})) setState(f.id, {v: values.get(f.id) ?? null});
  }
  map.on("load", () => {
    for (const el of container.querySelectorAll(".maplibregl-ctrl-attrib")) { el.classList.remove("maplibregl-compact-show"); el.removeAttribute("open"); }
    ready = true; apply();
  });
  map.on("sourcedata", (e) => { if (e.sourceId === "admin" && e.isSourceLoaded) applyValues(); });

  container.setValues = (v, o) => { values = v; opts = o ?? {}; apply(); };
  container.setRegion = (r) => { region = r; apply(); };
  container.fit = (b) => {
    const target = b ?? home;
    view = target; moved = false;
    if (target && container.clientWidth > 0) map.fitBounds(target, {padding: 24, duration: 500});
  };
  container.map = map;
  container.value = null;
  return container;
}
