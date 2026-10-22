// Cascading pulldowns for Observable Framework pages.
//
// Inputs.select builds a plain <select> whose option values index into the
// array it was given, and the form it returns has a `value` setter and re-reads
// itself on a bubbling "input" event. That is enough to make several selects
// aware of each other: after any of them changes, recompute which choices still
// have data under the other filters, grey the rest out, and if the current
// choice is one of them, fall back and notify the reactive graph.

/**
 * Grey out the options of an Inputs.select that have no data.
 *
 * @param input   the form returned by Inputs.select
 * @param data    the array the select was built from (same order)
 * @param valid   Set of the values that still have data
 * @param keep    a value that is always enabled (the "All" choice); null if none
 * @param fallback where to go when the current value became invalid; defaults to
 *                `keep`, or to the first valid value when there is no `keep`
 * @param suffix  appended to greyed-out labels
 * @returns true if the value was changed
 */
export function constrain(input, data, valid, {keep = "All", fallback, suffix = " — none"} = {}) {
  const select = input.querySelector("select");
  if (!select) return false;
  for (const opt of select.options) {
    const v = data[+opt.value];
    const ok = v === keep || valid.has(v);
    opt.disabled = !ok;
    if (opt.dataset.label === undefined) opt.dataset.label = opt.textContent;
    opt.textContent = ok ? opt.dataset.label : opt.dataset.label + suffix;
  }
  const cur = input.value;
  if (cur === keep || valid.has(cur)) return false;
  let next = fallback !== undefined ? fallback : keep !== null ? keep : data.find((d) => valid.has(d));
  if (next === undefined) return false;
  input.value = next;
  input.dispatchEvent(new Event("input", {bubbles: true}));
  return true;
}

/** Rows of `combos` matching every filter in `filters` (a value of "All" matches anything). */
export function matching(combos, filters) {
  const entries = Object.entries(filters).filter(([, v]) => v !== "All" && v !== undefined && v !== null);
  return combos.filter((c) => entries.every(([k, v]) => c[k] === v));
}

/** Set of distinct `key` values among the combos matching `filters`. */
export function available(combos, key, filters) {
  return new Set(matching(combos, filters).map((c) => c[key]));
}

/**
 * A closed pulldown that opens a checkbox panel — the multi-select shape Observable's
 * Inputs library doesn't ship (it only has an always-open checkbox list, or the browser's
 * native multi-select listbox). The button shows a summary ("All", one label, or "N
 * selected"); the panel closes on an outside click. Compatible with Generators.input(): the
 * returned element has a `value` getter/setter (an array, empty = nothing picked) and
 * dispatches a bubbling "input" event on every change.
 *
 * @param options   values to choose from, in display order
 * @param label     field label
 * @param format    value → display text
 * @param value      initial selection (default: none)
 * @param emptyLabel button text when nothing is selected
 * @param fullLabel  button text when every option is selected (default: "All (N)")
 */
export function checkboxSelect(options, {label, format = String, value = [], emptyLabel = "All", fullLabel} = {}) {
  let selected = new Set(value);

  const form = document.createElement("form");
  form.className = "inputs-3a86ea checkbox-select";
  if (label) {
    const lab = document.createElement("label");
    lab.textContent = label;
    form.appendChild(lab);
  }

  const wrap = document.createElement("div");
  wrap.className = "inputs-3a86ea-input checkbox-select-wrap";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "checkbox-select-button";

  const panel = document.createElement("div");
  panel.className = "checkbox-select-panel";
  panel.hidden = true;

  const actions = document.createElement("div");
  actions.className = "checkbox-select-actions";
  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.textContent = "Select all";
  const clearAll = document.createElement("button");
  clearAll.type = "button";
  clearAll.textContent = "Clear";
  selectAll.addEventListener("click", (e) => {
    e.preventDefault();
    selected = new Set(options);
    for (const {cb} of boxes) cb.checked = true;
    refresh();
    form.dispatchEvent(new Event("input", {bubbles: true}));
  });
  clearAll.addEventListener("click", (e) => {
    e.preventDefault();
    selected = new Set();
    for (const {cb} of boxes) cb.checked = false;
    refresh();
    form.dispatchEvent(new Event("input", {bubbles: true}));
  });
  actions.append(selectAll, clearAll);

  const boxes = options.map((opt) => {
    const row = document.createElement("label");
    row.className = "checkbox-select-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(opt);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(opt);
      else selected.delete(opt);
      refresh();
      form.dispatchEvent(new Event("input", {bubbles: true}));
    });
    row.append(cb, document.createTextNode(format(opt)));
    return {opt, cb, row};
  });
  panel.append(actions, ...boxes.map((b) => b.row));

  function refresh() {
    button.textContent = selected.size === 0 ? emptyLabel
      : selected.size === options.length ? (fullLabel ?? `All (${options.length})`)
      : selected.size === 1 ? format([...selected][0])
      : `${selected.size} selected`;
    button.classList.toggle("is-active", selected.size > 0 && selected.size < options.length);
  }
  refresh();

  button.addEventListener("click", (e) => {
    e.preventDefault();
    panel.hidden = !panel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) panel.hidden = true;
  });

  wrap.append(button, panel);
  form.appendChild(wrap);
  form.addEventListener("submit", (e) => e.preventDefault());

  Object.defineProperty(form, "value", {
    get: () => Array.from(selected),
    set(v) {
      selected = new Set(v ?? []);
      for (const {opt, cb} of boxes) cb.checked = selected.has(opt);
      refresh();
    }
  });

  if (!document.getElementById("checkbox-select-style")) {
    const style = document.createElement("style");
    style.id = "checkbox-select-style";
    style.textContent = `
      .checkbox-select-wrap { position: relative; }
      .checkbox-select-button {
        width: 100%; text-align: left; font: inherit; color: inherit;
        padding: 4px 28px 4px 8px; border: solid 1px var(--theme-foreground-faintest, #ccc);
        border-radius: 4px; background-color: #fff;
        background-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><path d="M0 0h8L4 6z" fill="%23888"/></svg>');
        background-repeat: no-repeat; background-position: right 10px center;
        cursor: pointer;
      }
      .checkbox-select-button.is-active { border-color: var(--theme-foreground-focus, #3b82f6); }
      .checkbox-select-panel {
        position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 100%;
        max-height: 220px; overflow: auto; background-color: #fff;
        border: solid 1px var(--theme-foreground-faintest, #ccc); border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0,0,0,.15); padding: 4px;
      }
      .checkbox-select-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; white-space: nowrap; border-radius: 4px; cursor: pointer; }
      .checkbox-select-row:hover { background: var(--theme-foreground-faintest, #f1f5f9); }
      .checkbox-select-row input { margin: 0; }
      .checkbox-select-actions { display: flex; gap: 10px; padding: 2px 6px 6px; margin-bottom: 4px; border-bottom: 1px solid var(--theme-foreground-faintest, #e5e7eb); }
      .checkbox-select-actions button { font: inherit; font-size: 11px; color: var(--theme-foreground-focus, #2563eb); background: none; border: none; padding: 0; cursor: pointer; }
      .checkbox-select-actions button:hover { text-decoration: underline; }
    `;
    document.head.appendChild(style);
  }

  return form;
}
