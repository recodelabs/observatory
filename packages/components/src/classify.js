// Class breaks and palettes for choropleths.

/** Up to n−1 rounded quantile breaks (n classes) for a set of values; nulls and NaN are left out. */
export function quantileBreaks(values, n = 6) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return [];
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const nice = (x) => { if (x <= 0) return 0; const p = 10 ** Math.floor(Math.log10(x)); return Math.round(x / p * 2) / 2 * p; };
  return [...new Set(Array.from({length: n - 1}, (_, i) => nice(q((i + 1) / n))))];
}

/** The darkest k + 1 colours of a sequential palette, for k breaks. */
export function colorsFor(breaks, palette = BLUES) {
  if (breaks.length + 1 > palette.length) throw new Error(`${breaks.length} breaks need ${breaks.length + 1} colours; the palette has ${palette.length}`);
  return palette.slice(palette.length - breaks.length - 1);
}

// Sequential (one hue, light → dark) and diverging (two hues, grey middle) palettes.
export const BLUES = ["#eff6ff", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
export const DIVERGING = ["#8c510a", "#d8b365", "#f6e8c3", "#f2f2f2", "#c7eae5", "#5ab4ac", "#01665e"];
