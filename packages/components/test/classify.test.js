import assert from "node:assert/strict";
import {test} from "node:test";
import {BLUES, colorsFor, quantileBreaks} from "../src/classify.js";
import {available, matching} from "../src/filters.js";

test("quantileBreaks: rounded, distinct, nulls left out", () => {
  const values = [null, NaN, ...Array.from({length: 100}, (_, i) => (i + 1) * 1000)];
  assert.deepEqual(quantileBreaks(values), [15000, 35000, 50000, 65000, 85000]);
  assert.deepEqual(quantileBreaks([5, 5, 5, 5]), [5]);
  assert.deepEqual(quantileBreaks([]), []);
});

test("colorsFor takes the darkest k + 1 colours", () => {
  assert.deepEqual(colorsFor([1, 2]), BLUES.slice(3));
  assert.equal(colorsFor([1, 2, 3, 4, 5]).length, 6);
  assert.throws(() => colorsFor([1, 2, 3, 4, 5, 6]), /need 7 colours/);
});

test("filters: matching and available ignore All", () => {
  const combos = [{a: "x", b: 1}, {a: "y", b: 2}, {a: "x", b: 3}];
  assert.deepEqual(matching(combos, {a: "x", b: "All"}), [combos[0], combos[2]]);
  assert.deepEqual([...available(combos, "b", {a: "x"})], [1, 3]);
});
