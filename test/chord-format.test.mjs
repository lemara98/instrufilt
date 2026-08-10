// Instrufilt — chord symbols, key estimation, transpose
//
//   node test/chord-format.test.mjs

import assert from "node:assert";
import CF from "../shared/chord-format.js";

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

console.log("\nnote naming");

check("defaults to sharps with no key context", () => {
  assert.strictEqual(CF.noteName(1), "C#");
  assert.strictEqual(CF.noteName(10), "A#");
});

check("spells flats in flat keys", () => {
  // The detail musicians notice instantly. Bb in F major, never A#.
  assert.strictEqual(CF.noteName(10, { keyPc: 5, keyMode: "maj" }), "Bb");   // F major
  assert.strictEqual(CF.noteName(3, { keyPc: 10, keyMode: "maj" }), "Eb");   // Bb major
  assert.strictEqual(CF.noteName(8, { keyPc: 3, keyMode: "maj" }), "Ab");    // Eb major
});

check("spells sharps in sharp keys", () => {
  assert.strictEqual(CF.noteName(6, { keyPc: 7, keyMode: "maj" }), "F#");    // G major
  assert.strictEqual(CF.noteName(1, { keyPc: 2, keyMode: "maj" }), "C#");    // D major
});

check("a minor key is spelled like its relative major", () => {
  // D minor has one flat, like F major.
  assert.strictEqual(CF.noteName(10, { keyPc: 2, keyMode: "min" }), "Bb");
  // E minor has one sharp, like G major.
  assert.strictEqual(CF.noteName(6, { keyPc: 4, keyMode: "min" }), "F#");
  // A minor has neither.
  assert.strictEqual(CF.noteName(6, { keyPc: 9, keyMode: "min" }), "F#");
});

check("an explicit preference overrides the key", () => {
  assert.strictEqual(CF.noteName(10, { keyPc: 7, keyMode: "maj", prefer: "flat" }), "Bb");
  assert.strictEqual(CF.noteName(10, { keyPc: 5, keyMode: "maj", prefer: "sharp" }), "A#");
});

check("every pitch class round-trips in both spellings", () => {
  for (let pc = 0; pc < 12; pc++) {
    assert.ok(CF.noteName(pc, { prefer: "sharp" }).length <= 2);
    assert.ok(CF.noteName(pc, { prefer: "flat" }).length <= 2);
  }
});

check("out-of-range pitch classes wrap", () => {
  assert.strictEqual(CF.noteName(12), "C");
  assert.strictEqual(CF.noteName(-1), "B");
  assert.strictEqual(CF.noteName(25), "C#");
});

console.log("\nchord symbols");

check("major and minor", () => {
  assert.strictEqual(CF.chordName({ root: 0, quality: 0 }), "C");
  assert.strictEqual(CF.chordName({ root: 9, quality: 1 }), "Am");
  assert.strictEqual(CF.chordName({ root: 5, quality: 0 }), "F");
});

check("no chord renders as N.C.", () => {
  assert.strictEqual(CF.chordName({ root: -1, quality: -1 }), "N.C.");
  assert.strictEqual(CF.chordName(null), "N.C.");
});

check("symbols honour key context", () => {
  const inF = { keyPc: 5, keyMode: "maj" };
  assert.strictEqual(CF.chordName({ root: 10, quality: 0 }, inF), "Bb");
  assert.strictEqual(CF.chordName({ root: 3, quality: 1 }, inF), "Ebm");
});

check("extended and slash chords — the Songle vocabulary", () => {
  assert.strictEqual(CF.chordName({ root: 7, quality: 1, ext: "7" }), "Gm7");
  assert.strictEqual(CF.chordName({ root: 0, quality: 0, ext: "maj7" }), "Cmaj7");
  assert.strictEqual(CF.chordName({ root: 10, quality: 0, ext: "sus4" },
    { keyPc: 5, keyMode: "maj" }), "Bbsus4");
  // The bass is spelled in key context too: Ab in Eb major, not G#.
  assert.strictEqual(CF.chordName({ root: 3, quality: 0, bass: 8 },
    { keyPc: 3, keyMode: "maj" }), "Eb/Ab");
  // A bass equal to the root is not a slash chord.
  assert.strictEqual(CF.chordName({ root: 0, quality: 0, bass: 0 }), "C");
});

check("noteToPc round-trips names and rejects garbage", () => {
  assert.strictEqual(CF.noteToPc("C"), 0);
  assert.strictEqual(CF.noteToPc("F#"), 6);
  assert.strictEqual(CF.noteToPc("Bb"), 10);
  assert.strictEqual(CF.noteToPc("Cb"), 11);
  assert.strictEqual(CF.noteToPc("E#"), 5);
  assert.strictEqual(CF.noteToPc("H"), null);
  assert.strictEqual(CF.noteToPc("C minor"), null);
  assert.strictEqual(CF.noteToPc(""), null);
  assert.strictEqual(CF.noteToPc(null), null);
});

console.log("\nkey estimation");

// A chromagram weighted toward one key's scale degrees.
function scaleChroma(tonic, mode) {
  const degrees = mode === "min" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const weights = mode === "min" ? [3, 1, 1.6, 1, 2.2, 1.4, 1.2] : [3, 1, 1.7, 1.4, 2.4, 1.5, 1.1];
  const v = new Array(12).fill(0.15);
  degrees.forEach((d, i) => { v[(tonic + d) % 12] = weights[i]; });
  return v;
}

check("finds a major key", () => {
  for (const tonic of [0, 5, 7, 2, 10]) {
    const k = CF.estimateKey(scaleChroma(tonic, "maj"));
    assert.strictEqual(k.pc, tonic, `expected tonic ${tonic}, got ${k.pc} ${k.mode}`);
    assert.strictEqual(k.mode, "maj");
  }
});

check("finds a minor key", () => {
  for (const tonic of [9, 4, 2]) {
    const k = CF.estimateKey(scaleChroma(tonic, "min"));
    assert.strictEqual(k.pc, tonic, `expected tonic ${tonic}, got ${k.pc} ${k.mode}`);
    assert.strictEqual(k.mode, "min");
  }
});

check("reports low confidence on a flat chromagram", () => {
  const k = CF.estimateKey(new Array(12).fill(1));
  assert.ok(k.confidence < 0.3, `confidence ${k.confidence.toFixed(3)} on featureless input`);
});

check("degenerate input does not throw", () => {
  assert.doesNotThrow(() => CF.estimateKey(null));
  assert.doesNotThrow(() => CF.estimateKey([1, 2, 3]));
});

check("key names read correctly", () => {
  assert.strictEqual(CF.keyName({ pc: 0, mode: "maj" }), "C major");
  assert.strictEqual(CF.keyName({ pc: 9, mode: "min" }), "A minor");
  assert.strictEqual(CF.keyName({ pc: 10, mode: "maj" }), "Bb major");
  assert.strictEqual(CF.keyName({ pc: 6, mode: "maj" }), "F# major");
});

console.log("\ntranspose and capo");

check("transposes and wraps", () => {
  assert.strictEqual(CF.transposeChord({ root: 0, quality: 0 }, 2).root, 2);
  assert.strictEqual(CF.transposeChord({ root: 11, quality: 0 }, 1).root, 0);
  assert.strictEqual(CF.transposeChord({ root: 0, quality: 0 }, -1).root, 11);
  assert.strictEqual(CF.transposeChord({ root: 0, quality: 0 }, -13).root, 11);
});

check("transposing preserves quality", () => {
  assert.strictEqual(CF.transposeChord({ root: 9, quality: 1 }, 3).quality, 1);
});

check("a slash chord's bass moves with the transpose", () => {
  const moved = CF.transposeChord({ root: 3, quality: 0, ext: "7", bass: 8 }, 2);
  assert.strictEqual(moved.root, 5);
  assert.strictEqual(moved.bass, 10);
  assert.strictEqual(moved.ext, "7", "the extension rides along untouched");
  // And without a bass, none appears.
  assert.strictEqual("bass" in CF.transposeChord({ root: 3, quality: 0 }, 2), false);
});

check("a capo lowers the read chord", () => {
  // Capo 2 and play D shapes to sound E: the READ chord is two semitones below.
  assert.strictEqual(CF.capoTranspose(2), -2);
  assert.strictEqual(CF.capoTranspose(0), 0);
});

check("capo is clamped to a playable range", () => {
  assert.strictEqual(CF.capoTranspose(20), -11, "no guitar has a capo past fret 11 worth using");
  assert.strictEqual(CF.capoTranspose(-5), 0);
});

console.log("\nlabelChart");

check("labels a whole chart in key context", () => {
  const chart = [
    { t: 0, root: 5, quality: 0 },    // F
    { t: 2, root: 10, quality: 0 },   // Bb
    { t: 4, root: 2, quality: 1 },    // Dm
  ];
  const out = CF.labelChart(chart, { key: { pc: 5, mode: "maj" } });
  assert.deepStrictEqual(out.map((c) => c.label), ["F", "Bb", "Dm"]);
});

check("transposing a chart moves the key with it", () => {
  // Up two from F major is G major, which is a SHARP key — so the same chord
  // that read Bb must now read C#, not Db, once transposed into it.
  const chart = [{ t: 0, root: 1, quality: 0 }];
  const inF = CF.labelChart(chart, { key: { pc: 5, mode: "maj" } });
  assert.strictEqual(inF[0].label, "Db", "Db in F major");
  const inG = CF.labelChart(chart, { key: { pc: 5, mode: "maj" }, transpose: 2 });
  assert.strictEqual(inG[0].label, "D#", "transposed into G major, spelled sharp");
});

check("preserves other fields", () => {
  const out = CF.labelChart([{ t: 1.5, endT: 3, root: 0, quality: 0, confidence: 0.8 }], {});
  assert.strictEqual(out[0].t, 1.5);
  assert.strictEqual(out[0].endT, 3);
  assert.strictEqual(out[0].confidence, 0.8);
});

check("empty and null charts are safe", () => {
  assert.deepStrictEqual(CF.labelChart([], {}), []);
  assert.deepStrictEqual(CF.labelChart(null, {}), []);
});

console.log("");
if (failures) {
  console.error(`${failures} chord-format test(s) failed`);
  process.exit(1);
}
console.log("chord format OK");
