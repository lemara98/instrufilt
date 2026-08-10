// Instrufilt — offline chord decoding
//
//   node test/chord-decode.test.mjs
//
// The point of the offline pass is that it beats the greedy per-frame argmax
// the causal decoder is stuck with. That comparison is the headline assertion:
// if Viterbi does not win here, it is not earning the buffering, the storage,
// or the two-tier "Listening then Chart" UX built on top of it.

import assert from "node:assert";
import CD from "../shared/chord-decode.js";

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

const FPS = 23.4375;

// Synthetic chroma for a triad: the three chord tones lit, everything else at a
// low floor, then L2-normalised — the same shape chroma.c produces.
function triadChroma(root, quality, noise = 0, rand = () => 0) {
  const iv = quality === 0 ? [0, 4, 7] : [0, 3, 7];
  const v = new Array(12).fill(0.05);
  for (const i of iv) v[(root + i) % 12] = 1;
  for (let i = 0; i < 12; i++) v[i] = Math.max(0, v[i] + noise * rand());
  let s = 0;
  for (const x of v) s += x * x;
  const inv = 1 / Math.sqrt(s);
  return v.map((x) => x * inv);
}

function bassFor(root) {
  const v = new Array(12).fill(0.05);
  v[root] = 1;
  let s = 0;
  for (const x of v) s += x * x;
  const inv = 1 / Math.sqrt(s);
  return v.map((x) => x * inv);
}

// Deterministic PRNG — a flaky decoder test is worse than no decoder test.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** progression: [{root, quality, seconds}] -> frames */
function buildFrames(progression, { noise = 0, seed = 42, glitchEvery = 0 } = {}) {
  const rand = mulberry(seed);
  const frames = [];
  let t = 0;
  let n = 0;
  for (const seg of progression) {
    const count = Math.round(seg.seconds * FPS);
    for (let i = 0; i < count; i++) {
      let root = seg.root, quality = seg.quality;
      // Inject a single-frame wrong chord — exactly the error a causal argmax
      // cannot undo and a transition prior should absorb.
      if (glitchEvery && n > 0 && n % glitchEvery === 0) {
        root = (root + 5) % 12;
        quality = 1 - quality;
      }
      frames.push({ t, chroma: triadChroma(root, quality, noise, rand), bass: bassFor(root) });
      t += 1 / FPS;
      n++;
    }
  }
  return frames;
}

const I_V_vi_IV = [
  { root: 0, quality: 0, seconds: 2 },   // C
  { root: 7, quality: 0, seconds: 2 },   // G
  { root: 9, quality: 1, seconds: 2 },   // Am
  { root: 5, quality: 0, seconds: 2 },   // F
];

console.log("\nclean decoding");

check("recovers a clean progression exactly", () => {
  const segs = CD.decode(buildFrames(I_V_vi_IV));
  assert.strictEqual(segs.length, 4, `got ${segs.length} segments`);
  assert.deepStrictEqual(
    segs.map((s) => `${s.root}:${s.quality}`),
    ["0:0", "7:0", "9:1", "5:0"]
  );
});

check("segment boundaries land within 150 ms", () => {
  const segs = CD.decode(buildFrames(I_V_vi_IV));
  const want = [0, 2, 4, 6];
  segs.forEach((s, i) => {
    assert.ok(Math.abs(s.t - want[i]) < 0.15,
      `segment ${i} starts at ${s.t.toFixed(2)}s, expected ${want[i]}s`);
  });
});

check("distinguishes a major from its relative minor", () => {
  // C and Am share two of three tones. The bass chroma is the only thing that
  // separates them, which is why chroma.c computes it separately at all.
  const segs = CD.decode(buildFrames([
    { root: 0, quality: 0, seconds: 3 },
    { root: 9, quality: 1, seconds: 3 },
  ]));
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].root, 0);
  assert.strictEqual(segs[0].quality, 0);
  assert.strictEqual(segs[1].root, 9);
  assert.strictEqual(segs[1].quality, 1);
});

console.log("\nViterbi vs greedy");

check("Viterbi beats greedy on frames with injected single-frame errors", () => {
  const frames = buildFrames(I_V_vi_IV, { glitchEvery: 11 });
  const truth = [];
  for (const seg of I_V_vi_IV) {
    const count = Math.round(seg.seconds * FPS);
    for (let i = 0; i < count; i++) truth.push(seg.quality * 12 + seg.root);
  }

  const acc = (path) => path.reduce((n, s, i) => n + (s === truth[i] ? 1 : 0), 0) / path.length;
  const g = acc(CD.greedy(frames));
  const v = acc(CD.viterbi(frames));

  assert.ok(v > g, `viterbi ${(v * 100).toFixed(1)}% vs greedy ${(g * 100).toFixed(1)}%`);
  assert.ok(v > 0.95, `viterbi should absorb nearly all single-frame glitches, got ${(v * 100).toFixed(1)}%`);
  console.log(`       (greedy ${(g * 100).toFixed(1)}% -> viterbi ${(v * 100).toFixed(1)}%)`);
});

check("Viterbi beats greedy under chroma noise", () => {
  const frames = buildFrames(I_V_vi_IV, { noise: 0.55, seed: 7 });
  const truth = [];
  for (const seg of I_V_vi_IV) {
    const count = Math.round(seg.seconds * FPS);
    for (let i = 0; i < count; i++) truth.push(seg.quality * 12 + seg.root);
  }
  const acc = (path) => path.reduce((n, s, i) => n + (s === truth[i] ? 1 : 0), 0) / path.length;
  const g = acc(CD.greedy(frames));
  const v = acc(CD.viterbi(frames));
  assert.ok(v >= g, `viterbi ${(v * 100).toFixed(1)}% vs greedy ${(g * 100).toFixed(1)}%`);
  console.log(`       (greedy ${(g * 100).toFixed(1)}% -> viterbi ${(v * 100).toFixed(1)}%)`);
});

check("is deterministic", () => {
  const frames = buildFrames(I_V_vi_IV, { noise: 0.4, seed: 99 });
  assert.deepStrictEqual(CD.viterbi(frames), CD.viterbi(frames));
});

console.log("\nsilence and non-harmonic input");

check("flat chroma decodes to N, not to a chord", () => {
  const flat = new Array(12).fill(1 / Math.sqrt(12));
  const frames = Array.from({ length: 60 }, (_, i) => ({
    t: i / FPS, chroma: flat, bass: flat,
  }));
  const path = CD.viterbi(frames);
  assert.ok(path.every((s) => s === CD.NONE),
    `expected all N, got states ${[...new Set(path)].join(",")}`);
  assert.deepStrictEqual(CD.decode(frames), [], "N must not become a chord segment");
});

check("N segments are dropped from the output but still break runs", () => {
  const flat = new Array(12).fill(1 / Math.sqrt(12));
  const frames = [
    ...buildFrames([{ root: 0, quality: 0, seconds: 2 }]),
    ...Array.from({ length: 40 }, (_, i) => ({ t: 2 + i / FPS, chroma: flat, bass: flat })),
    ...buildFrames([{ root: 0, quality: 0, seconds: 2 }]).map((f) => ({ ...f, t: f.t + 3.7 })),
  ];
  const segs = CD.decode(frames);
  assert.strictEqual(segs.length, 2, "the silence must split C into two segments, not merge them");
  assert.ok(segs.every((s) => s.root === 0 && s.quality === 0));
});

console.log("\nsegments");

check("segments shorter than the minimum are dropped", () => {
  const segs = CD.decode(buildFrames([
    { root: 0, quality: 0, seconds: 2 },
    { root: 2, quality: 0, seconds: 0.15 },   // too brief to play
    { root: 7, quality: 0, seconds: 2 },
  ]));
  assert.ok(!segs.some((s) => s.root === 2), "a 0.15s chord is not playable");
});

check("identical neighbours merge after a drop", () => {
  const segs = CD.decode(buildFrames([
    { root: 0, quality: 0, seconds: 2 },
    { root: 3, quality: 1, seconds: 0.1 },
    { root: 0, quality: 0, seconds: 2 },
  ]));
  assert.strictEqual(segs.length, 1, `expected one merged C, got ${segs.length}`);
});

check("segments carry a confidence and an end time", () => {
  const segs = CD.decode(buildFrames(I_V_vi_IV));
  for (const s of segs) {
    assert.ok(s.confidence > 0 && s.confidence <= 1, `confidence ${s.confidence}`);
    assert.ok(s.endT > s.t, `endT ${s.endT} must follow t ${s.t}`);
  }
});

check("empty input is handled", () => {
  assert.deepStrictEqual(CD.decode([]), []);
  assert.deepStrictEqual(CD.viterbi([]), []);
  assert.deepStrictEqual(CD.decode(null), []);
});

console.log("\naggregateChroma");

check("aggregates and normalises across frames", () => {
  const agg = CD.aggregateChroma(buildFrames(I_V_vi_IV));
  let s = 0;
  for (const v of agg) s += v * v;
  assert.ok(Math.abs(s - 1) < 1e-6, `expected unit norm, got ${s}`);
  // C, G, Am, F between them use C E G B D F A — C and G appear in three of
  // the four chords, so they should dominate.
  const ranked = agg.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map((p) => p[1]);
  assert.ok(ranked.slice(0, 3).includes(0), `C should rank high; order was ${ranked.join(",")}`);
  assert.ok(ranked.slice(0, 3).includes(7), `G should rank high; order was ${ranked.join(",")}`);
});

console.log("");
if (failures) {
  console.error(`${failures} chord-decode test(s) failed`);
  process.exit(1);
}
console.log("chord decode OK");
