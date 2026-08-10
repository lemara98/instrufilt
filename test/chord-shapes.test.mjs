// Instrufilt — guitar fingering shapes
//
//   node test/chord-shapes.test.mjs
//
// shapeFor() is the pure half of chord-shapes.js; the SVG half needs a DOM
// and is exercised by using the panel.

import assert from "node:assert";
import CSH from "../shared/chord-shapes.js";

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

console.log("\nopen shapes — the grips guitarists expect to see");

check("C major looks like C, not like an A-barre at fret 3", () => {
  assert.deepStrictEqual(CSH.shapeFor({ root: 0, quality: 0 }),
    { frets: [-1, 3, 2, 0, 1, 0], baseFret: 1 });
});

check("the cowboy chords", () => {
  assert.deepStrictEqual(CSH.shapeFor({ root: 7, quality: 0 }).frets, [3, 2, 0, 0, 0, 3]);   // G
  assert.deepStrictEqual(CSH.shapeFor({ root: 2, quality: 0 }).frets, [-1, -1, 0, 2, 3, 2]); // D
  assert.deepStrictEqual(CSH.shapeFor({ root: 4, quality: 1 }).frets, [0, 2, 2, 0, 0, 0]);   // Em
  assert.deepStrictEqual(CSH.shapeFor({ root: 9, quality: 1 }).frets, [-1, 0, 2, 2, 1, 0]);  // Am
  assert.deepStrictEqual(CSH.shapeFor({ root: 9, quality: 1, ext: "7" }).frets,
    [-1, 0, 2, 0, 1, 0]);                                                                     // Am7
});

console.log("\nbarre shapes");

check("F is the E-shape barred at 1", () => {
  assert.deepStrictEqual(CSH.shapeFor({ root: 5, quality: 0 }),
    { frets: [1, 3, 3, 2, 1, 1], baseFret: 1 });
});

check("B is the A-shape barred at 2 — the lower of the two options", () => {
  assert.deepStrictEqual(CSH.shapeFor({ root: 11, quality: 0 }),
    { frets: [-1, 1, 3, 3, 3, 1], baseFret: 2 });
});

check("F#m is the E-shape barred at 2", () => {
  assert.deepStrictEqual(CSH.shapeFor({ root: 6, quality: 1 }),
    { frets: [1, 3, 3, 1, 1, 1], baseFret: 2 });
});

check("Bbm7 lands on a playable barre", () => {
  const s = CSH.shapeFor({ root: 10, quality: 1, ext: "7" });
  assert.ok(s, "expected a shape");
  assert.ok(s.baseFret >= 1 && s.baseFret <= 8, `baseFret ${s.baseFret} is up the neck`);
});

console.log("\nhonesty rules");

check("no template lies: dim/aug/altered return null", () => {
  assert.strictEqual(CSH.shapeFor({ root: 0, quality: 0, ext: "dim" }), null);
  assert.strictEqual(CSH.shapeFor({ root: 0, quality: 0, ext: "aug" }), null);
  assert.strictEqual(CSH.shapeFor({ root: 9, quality: 1, ext: "7b5" }), null);
});

check("extensions degrade to honest simplifications", () => {
  // add9 -> plain triad; 13 -> dominant 7; m9 -> m7.
  assert.strictEqual(CSH.templateKind(0, "add9"), "maj");
  assert.strictEqual(CSH.templateKind(0, "13"), "7");
  assert.strictEqual(CSH.templateKind(1, "9"), "m7");
  assert.strictEqual(CSH.templateKind(0, "sus4"), "sus4");
  assert.strictEqual(CSH.templateKind(1, "maj7"), null, "minor-major-seventh has no template");
});

check("every root gets a shape for the four everyday kinds", () => {
  for (let pc = 0; pc < 12; pc++) {
    for (const [quality, ext] of [[0, undefined], [1, undefined], [0, "7"], [1, "7"]]) {
      const s = CSH.shapeFor({ root: pc, quality, ext });
      assert.ok(s, `no shape for pc ${pc} quality ${quality} ext ${ext}`);
      assert.strictEqual(s.frets.length, 6);
      assert.ok(s.frets.every((f) => f >= -1 && f <= 5), `unrenderable fret in ${s.frets}`);
    }
  }
});

check("degenerate input is safe", () => {
  assert.strictEqual(CSH.shapeFor(null), null);
  assert.strictEqual(CSH.shapeFor({}), null);
  assert.strictEqual(CSH.shapeFor({ root: -1, quality: -1 }), null);
});

console.log("");
if (failures) {
  console.error(`${failures} chord-shapes test(s) failed`);
  process.exit(1);
}
console.log("chord shapes OK");
