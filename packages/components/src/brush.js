// A range filter drawn on a chart: drag across an Observable Plot chart to pick a range of
// its x axis. Nothing is added to a chart unless the page calls brushX on it.
//
//   const histogram = brushX(Plot.plot({…}));          // the chart, now also a filter
//   const range = Generators.input(histogram);         // [low, high], or null for everything
//   const shown = rows.filter((d) => within(range, d.ratio, {min: 20, max: 200}));
//
// Drag to select, drag the selection to move it, drag an edge to resize it, and click
// outside it (or "Clear") to remove it. Bars outside the selection are faded.
import {brushX as d3BrushX} from "d3-brush";
import {select} from "d3-selection";

const GRIP = {width: 8, height: 44};

/**
 * Add a drag selection along x to a chart made by Plot.plot.
 *
 * @param plot     the element returned by Plot.plot, with a continuous x scale (linear, time)
 * @param enabled  false returns the chart as it is, with a value of null, so a page can
 *                 switch the filter off without changing the cells that read it
 * @param value    a selection to start with, [low, high] in x values. Pass the current range
 *                 when the chart is redrawn (on a resize, for example) to keep it
 * @param round    applied to each end of the selection; the default rounds numbers to whole
 *                 values and leaves dates alone. Pass (v) => v for no rounding
 * @param marks    CSS selector of the marks to fade outside the selection
 * @param color    colour of the selection's outline and handles
 * @param clear    text of the control that removes the selection; null for none
 * @returns the same element, with `value` ([low, high] or null), an "input" event when a
 *          drag ends, and `clear()` to remove the selection
 */
export function brushX(plot, {
  enabled = true,
  value = null,
  round = (v) => (typeof v === "number" ? Math.round(v) : v),
  marks = 'g[aria-label="rect"] rect',
  color = "currentColor",
  clear = "Clear"
} = {}) {
  plot.value = null;
  plot.clear = () => {};
  if (!enabled) return plot;

  // Plot.plot returns a <figure> around the chart when it has a title or legend, and a
  // legend's swatches are small <svg> elements too: the chart is the one with Plot's class.
  const svg = plot.matches?.("svg") ? plot : plot.querySelector('svg[class^="plot"]') ?? [...plot.querySelectorAll("svg")].pop();
  const x = plot.scale("x");
  if (!svg || !x?.invert) throw new Error("brushX needs a Plot chart with a continuous x scale");
  const [left, right] = [...x.range].sort((a, b) => a - b);
  // With rows of facets, the selection runs down all of them.
  const [top, bottom] = [...(plot.scale("fy") ?? plot.scale("y") ?? {range: [0, +svg.getAttribute("height")]}).range].sort((a, b) => a - b);

  const faded = select(svg).selectAll(marks);
  const before = new Map();
  faded.each(function () { before.set(this, {stroke: this.getAttribute("stroke"), width: this.getAttribute("stroke-width")}); });
  const middle = (el) => {
    if (el.hasAttribute("x") && el.hasAttribute("width")) return +el.getAttribute("x") + +el.getAttribute("width") / 2;
    const box = el.getBBox();
    return box.x + box.width / 2;
  };

  // Marks in the selection get a thin outline, the rest are faded; grips mark its two edges.
  function show(selection) {
    faded.each(function () {
      const m = middle(this);
      const inside = !selection || (m >= selection[0] && m <= selection[1]);
      const was = before.get(this);
      select(this).attr("opacity", inside ? null : 0.3)
        .attr("stroke", selection && inside ? color : was.stroke)
        .attr("stroke-width", selection && inside ? 0.75 : was.width);
    });
    grip.attr("display", selection ? null : "none");
    if (selection) grip.attr("x", (i) => selection[i] - GRIP.width / 2);
    reset?.attr("display", selection ? null : "none");
  }
  const toValue = (selection) => (selection ? selection.map((px) => round(x.invert(px))) : null);

  const brush = d3BrushX().extent([[left, top], [right, bottom]])
    .on("brush", (event) => show(event.selection))
    .on("end", (event) => {
      show(event.selection);
      plot.value = toValue(event.selection);
      // Moves made by the code (the starting value) set the value without announcing it.
      if (event.sourceEvent || announce) plot.dispatchEvent(new Event("input", {bubbles: true}));
    });
  let announce = false;

  const g = select(svg).append("g").attr("class", "observatory-brush").call(brush);
  g.select(".selection").attr("fill", color).attr("fill-opacity", 0.06)
    .attr("stroke", color).attr("stroke-opacity", 0.5).attr("stroke-dasharray", "3,2");
  const grip = g.selectAll(".grip").data([0, 1]).join("rect").attr("class", "grip")
    .attr("width", GRIP.width).attr("height", Math.min(GRIP.height, bottom - top)).attr("rx", 4)
    .attr("y", (top + bottom - Math.min(GRIP.height, bottom - top)) / 2)
    .attr("fill", "var(--theme-background, white)").attr("stroke", color).attr("stroke-width", 1.2)
    .attr("pointer-events", "none").attr("display", "none");

  plot.clear = () => { announce = true; g.call(brush.move, null); announce = false; };
  const reset = clear == null ? null : select(svg).append("text").text(clear)
    .attr("x", right).attr("y", Math.max(11, top - 6)).attr("text-anchor", "end")
    .attr("font-size", 11).attr("fill", color).attr("text-decoration", "underline")
    .attr("display", "none").style("cursor", "pointer")
    .on("click", plot.clear);

  if (value) {
    const px = value.map((v) => Math.max(left, Math.min(right, x.apply(v)))).sort((a, b) => a - b);
    if (px[1] > px[0]) g.call(brush.move, px);
  }
  return plot;
}

/**
 * Whether a value is inside a range from brushX. No range means everything is.
 *
 * @param range  [low, high] or null
 * @param value  the value to test; null or undefined is outside any range
 * @param min    the low end of the chart's axis, when the first bar also holds everything
 *               below it: a range that reaches it has no lower limit
 * @param max    the same for the high end
 */
export function within(range, value, {min, max} = {}) {
  if (!range) return true;
  if (value == null || Number.isNaN(value)) return false;
  const [low, high] = range;
  return ((min != null && low <= min) || value >= low) && ((max != null && high >= max) || value <= high);
}
