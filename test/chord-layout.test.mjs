// Instrufilt — chord placement on lyric lines
//
//   node test/chord-layout.test.mjs

import assert from "node:assert";
import CL from "../shared/chord-layout.js";
import LRC from "../shared/lrc.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const labels = (map, i) => (map.get(i) || []).map((c) => c.label);

console.log("\nword-timed placement (exact)");

const timed = LRC.parseLRC(
  "[00:10.00]<00:10.00>Hello <00:11.00>darkness <00:12.00>my <00:13.00>old <00:14.00>friend\n" +
  "[00:20.00]<00:20.00>next <00:21.00>line"
);

check("a chord lands on the word that was sounding", () => {
  const m = CL.chordsForLine([{ t: 12.4, label: "F" }], timed[0], timed[1]);
  assert.deepStrictEqual(labels(m, 2), ["F"], "12.4s falls inside 'my' (12.0-13.0)");
});

check("a chord exactly on a word onset lands on that word, not the previous one", () => {
  const m = CL.chordsForLine([{ t: 13.0, label: "C" }], timed[0], timed[1]);
  assert.deepStrictEqual(labels(m, 3), ["C"]);
  assert.deepStrictEqual(labels(m, 2), []);
});

check("a chord before the first word still lands on it", () => {
  const m = CL.chordsForLine([{ t: 10.0, label: "Am" }], timed[0], timed[1]);
  assert.deepStrictEqual(labels(m, 0), ["Am"]);
});

check("a chord after the last word lands on the last word", () => {
  const m = CL.chordsForLine([{ t: 19.5, label: "G" }], timed[0], timed[1]);
  assert.deepStrictEqual(labels(m, 4), ["G"]);
});

check("chords outside the line are excluded", () => {
  const m = CL.chordsForLine(
    [{ t: 5, label: "before" }, { t: 25, label: "after" }, { t: 11.5, label: "in" }],
    timed[0], timed[1]
  );
  const all = [...m.values()].flat().map((c) => c.label);
  assert.deepStrictEqual(all, ["in"]);
});

console.log("\nline-timed placement (estimated)");

// Deliberately the SAME equal-slice assumption the word sweep makes, so chord
// and highlight stay consistent even though both are approximate.
const plain = LRC.parseLRC("[00:00.00]one two three four\n[00:40.00]next");

check("splits the line into equal slices per word", () => {
  const m = CL.chordsForLine(
    [{ t: 0, label: "A" }, { t: 10, label: "B" }, { t: 20, label: "C" }, { t: 30, label: "D" }],
    plain[0], plain[1]
  );
  assert.deepStrictEqual(labels(m, 0), ["A"]);
  assert.deepStrictEqual(labels(m, 1), ["B"]);
  assert.deepStrictEqual(labels(m, 2), ["C"]);
  assert.deepStrictEqual(labels(m, 3), ["D"]);
});

check("a chord at the very end clamps to the last word", () => {
  const m = CL.chordsForLine([{ t: 39.99, label: "Z" }], plain[0], plain[1]);
  assert.deepStrictEqual(labels(m, 3), ["Z"]);
});

console.log("\ncollisions");

check("two chords on one word stack on that word", () => {
  const m = CL.chordsForLine([{ t: 12.1, label: "F" }, { t: 12.6, label: "G" }], timed[0], timed[1]);
  assert.deepStrictEqual(labels(m, 2), ["F", "G"], "both belong to 'my' (12.0-13.0)");
  assert.deepStrictEqual(labels(m, 3), [], "nothing may be displaced onto 'old'");
});

check("a stacked collision never displaces a LATER chord", () => {
  // The reason bumping was rejected. F and G both belong to 'my'; C belongs to
  // 'old'. Bumping G onto 'old' would push C onto 'friend' — a chord over a
  // word it has nothing to do with, which is a wrong instruction, not an
  // untidy one.
  const m = CL.chordsForLine(
    [{ t: 12.1, label: "F" }, { t: 12.6, label: "G" }, { t: 13.1, label: "C" }],
    timed[0], timed[1]
  );
  assert.deepStrictEqual(labels(m, 2), ["F", "G"]);
  assert.deepStrictEqual(labels(m, 3), ["C"], "C must stay on the word it was played over");
  assert.deepStrictEqual(labels(m, 4), []);
});

check("a collision on the LAST word stays on the last word", () => {
  const m = CL.chordsForLine([{ t: 14.1, label: "A" }, { t: 14.5, label: "B" }], timed[0], timed[1]);
  assert.strictEqual(m.has(5), false, "index 5 does not exist on a 5-word line");
  assert.deepStrictEqual(labels(m, 4), ["A", "B"]);
});

console.log("\ndegenerate input");

check("no chords yields an empty map", () => {
  assert.strictEqual(CL.chordsForLine([], timed[0], timed[1]).size, 0);
  assert.strictEqual(CL.chordsForLine(null, timed[0], timed[1]).size, 0);
});

check("no line yields an empty map", () => {
  assert.strictEqual(CL.chordsForLine([{ t: 1, label: "A" }], null, null).size, 0);
});

check("a single-word line takes every chord on word 0", () => {
  const one = LRC.parseLRC("[00:00.00]solo\n[00:10.00]next");
  const m = CL.chordsForLine([{ t: 1, label: "A" }, { t: 5, label: "B" }], one[0], one[1]);
  assert.deepStrictEqual(labels(m, 0).sort(), ["A", "B"]);
});

check("the last line is bounded by a tail, not by infinity", () => {
  const m = CL.chordsForLine(
    [{ t: 21.5, label: "in" }, { t: 30, label: "way-out" }],
    timed[1], null
  );
  const all = [...m.values()].flat().map((c) => c.label);
  assert.deepStrictEqual(all, ["in"], `tail is ${CL.LAST_LINE_TAIL_SECONDS}s`);
});

check("RTL text places by index, not by visual position", () => {
  // Word index is document order; bidi is the renderer's problem. A chord on
  // word 1 must stay on word 1 regardless of script.
  const rtl = LRC.parseLRC("[00:00.00]<00:00.00>שלום <00:01.00>עולם\n[00:10.00]next");
  const m = CL.chordsForLine([{ t: 1.2, label: "Dm" }], rtl[0], rtl[1]);
  assert.deepStrictEqual(labels(m, 1), ["Dm"]);
});

console.log("\nchordsInGap");

check("returns only the chords inside the gap", () => {
  const gap = { start: 10, end: 20, nextIndex: 3 };
  const got = CL.chordsInGap(
    [{ t: 9.9, label: "before" }, { t: 10, label: "A" }, { t: 15, label: "B" }, { t: 20, label: "after" }],
    gap
  ).map((c) => c.label);
  assert.deepStrictEqual(got, ["A", "B"]);
});

check("no gap or no chords yields nothing", () => {
  assert.deepStrictEqual(CL.chordsInGap([{ t: 1, label: "A" }], null), []);
  assert.deepStrictEqual(CL.chordsInGap(null, { start: 0, end: 5 }), []);
});

console.log("");
if (failures) {
  console.error(`${failures} chord-layout test(s) failed`);
  process.exit(1);
}
console.log("chord layout OK");
