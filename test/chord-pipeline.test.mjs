// Instrufilt — end-to-end chord pipeline
//
//   node test/chord-pipeline.test.mjs
//
// Synthesised audio -> the SHIPPED .wasm -> drained chroma frames -> the real
// JS Viterbi -> a chart. Every other test covers one link; this covers the
// seams between them, which is where this design is actually risky:
//
//   * the C and JS scorers must agree about what a chroma vector means — they
//     are separate implementations of the same formula, in different languages,
//     tuned by different constants
//   * frame timestamps must survive the trip from the audio thread onto the
//     media timeline, through two offsets that are easy to get subtly wrong
//   * the exported frame layout must match what the worklet slices out of it
//
// Any of those can be individually correct and jointly wrong, and the symptom
// would be a chart that is plausible but shifted or transposed.

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import CD from "../shared/chord-decode.js";
import CF from "../shared/chord-format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "..", "wasm/build/vocal_isolate.wasm");

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

console.log("\nchord pipeline (wasm -> viterbi -> chart)");

if (!existsSync(WASM)) {
  console.log("  skip  wasm not built — run `make`");
  process.exit(0);
}

const SR = 48000;
const BLOCK = 128;
const FRAME_FLOATS = 28;      // must equal CHROMA_FRAME_FLOATS in chroma.h
const ISO_LATENCY = 2048;

const module = new WebAssembly.Module(readFileSync(WASM));
let instance = null;
for (const imports of [
  {
    env: { emscripten_notify_memory_growth: () => {} },
    wasi_snapshot_preview1: { proc_exit: () => {}, fd_write: () => 0, fd_seek: () => 0, fd_close: () => 0 },
  },
  { env: {} },
]) {
  try { instance = new WebAssembly.Instance(module, imports); break; } catch { /* next */ }
}
assert.ok(instance, "wasm would not instantiate");
const x = instance.exports;

check("wasm exports the chroma ABI the worklet calls", () => {
  for (const fn of [
    "chroma_init", "chroma_enable", "chroma_reset", "chroma_feed",
    "chroma_pop_frame", "chroma_get_frame_ptr",
    "chroma_pop_event", "chroma_get_event_ptr", "chroma_get_tuning",
  ]) {
    assert.strictEqual(typeof x[fn], "function", `missing export: ${fn}`);
  }
});

// ── synthesis ─────────────────────────────────────────────────────────────

function midiHz(midi, a4 = 440) { return a4 * Math.pow(2, (midi - 69) / 12); }

function addNote(buf, midi, amp, start, len, a4 = 440) {
  const f0 = midiHz(midi, a4);
  for (let h = 1; h <= 6; h++) {
    const f = f0 * h;
    if (f > SR * 0.45) break;
    const a = amp / h;
    for (let i = 0; i < len && start + i < buf.length; i++) {
      let env = 1;
      if (i < 480) env = i / 480;
      else if (i > len - 960) env = Math.max(0, (len - i) / 960);
      buf[start + i] += a * env * Math.sin((2 * Math.PI * f * i) / SR);
    }
  }
}

function addTriad(buf, root, quality, octaveBase, amp, start, len, a4 = 440) {
  const iv = quality === 0 ? [0, 4, 7] : [0, 3, 7];
  for (const step of iv) addNote(buf, octaveBase + root + step, amp, start, len, a4);
  addNote(buf, octaveBase + root - 24, amp * 1.1, start, len, a4);   // bass
}

/** Run a mono buffer through the real wasm, returning drained chroma frames. */
function analyse(buf) {
  x.isolate_init(SR);
  x.isolate_set_mode(1);
  x.isolate_set_amount(1);
  x.isolate_set_makeup_db(0);
  x.isolate_set_auto_gain(0);
  x.chroma_init(SR);
  x.chroma_reset();
  x.chroma_enable(1);

  const mem = x.memory.buffer;
  const inL = new Float32Array(mem, x.isolate_get_input_l(), BLOCK);
  const inR = new Float32Array(mem, x.isolate_get_input_r(), BLOCK);
  const frameView = new Float32Array(mem, x.chroma_get_frame_ptr(), FRAME_FLOATS);
  const eventView = new Float32Array(mem, x.chroma_get_event_ptr(), 6);

  const frames = [];
  const events = [];
  for (let off = 0; off + BLOCK <= buf.length; off += BLOCK) {
    for (let i = 0; i < BLOCK; i++) { inL[i] = buf[off + i]; inR[i] = buf[off + i]; }
    x.isolate_process(BLOCK);
    x.chroma_feed(BLOCK);

    // Drain often — the ring holds 96 frames and would otherwise drop the
    // oldest, exactly as it would in the browser if the worklet stopped
    // draining.
    while (x.chroma_pop_frame()) {
      frames.push({
        t: frameView[0],
        tuning: frameView[1],
        chroma: frameView.slice(2, 14),
        bass: frameView.slice(14, 26),
        energy: frameView[26],
      });
    }
    while (x.chroma_pop_event()) {
      events.push({ t: eventView[0], root: eventView[1], quality: eventView[2], conf: eventView[3] });
    }
  }
  return { frames, events, tuning: x.chroma_get_tuning() };
}

// I - V - vi - IV in C, 2 s each.
const PROG = [
  { root: 0, quality: 0, name: "C" },
  { root: 7, quality: 0, name: "G" },
  { root: 9, quality: 1, name: "Am" },
  { root: 5, quality: 0, name: "F" },
];
const PER = SR * 2;

function buildProgression(a4 = 440) {
  const buf = new Float32Array(PER * PROG.length);
  PROG.forEach((c, i) => addTriad(buf, c.root, c.quality, 48, 0.22, i * PER, PER, a4));
  return buf;
}

const analysed = analyse(buildProgression());

check("frames are produced at the expected rate", () => {
  // 2048-sample hop at 48 kHz -> 23.44 fps over 8 s.
  const expected = (8 * SR) / 2048;
  assert.ok(
    Math.abs(analysed.frames.length - expected) < expected * 0.12,
    `got ${analysed.frames.length} frames, expected about ${expected.toFixed(0)}`
  );
});

check("frame timestamps land on the input timeline, not the delayed one", () => {
  // chroma.c folds out both its own window centring and the isolation group
  // delay. If either were missed, every timestamp — and so every chord in the
  // chart — would be shifted by a fixed amount that looks like mere lateness.
  const first = analysed.frames[0].t;
  const expected = -(8192 / 2 + ISO_LATENCY) / SR + 8192 / SR;
  assert.ok(Math.abs(first - expected) < 0.05,
    `first frame at ${first.toFixed(3)}s, expected about ${expected.toFixed(3)}s`);

  const last = analysed.frames[analysed.frames.length - 1].t;
  assert.ok(Math.abs(last - 8) < 0.35, `last frame at ${last.toFixed(2)}s, audio is 8s`);
});

check("frames advance monotonically by one hop", () => {
  const dt = 2048 / SR;
  for (let i = 1; i < analysed.frames.length; i++) {
    const d = analysed.frames[i].t - analysed.frames[i - 1].t;
    assert.ok(Math.abs(d - dt) < 1e-4,
      `frame ${i} advanced ${d.toFixed(5)}s, expected ${dt.toFixed(5)}s`);
  }
});

check("chroma vectors are L2-normalised, as the JS scorer assumes", () => {
  // The scorers share thresholds (MIN_FIT). If the C stopped normalising, the
  // JS gate would silently mean something different.
  const mid = analysed.frames[Math.floor(analysed.frames.length / 2)];
  let s = 0;
  for (const v of mid.chroma) s += v * v;
  assert.ok(Math.abs(Math.sqrt(s) - 1) < 0.02, `|chroma| = ${Math.sqrt(s).toFixed(4)}`);
});

console.log("\ndecoding the real frames");

const chart = CD.decode(analysed.frames);

check("recovers the progression from real wasm output", () => {
  assert.strictEqual(chart.length, 4, `got ${chart.length} segments: ` +
    chart.map((c) => CF.chordName(c)).join(" "));
  assert.deepStrictEqual(
    chart.map((c) => CF.chordName(c)),
    ["C", "G", "Am", "F"]
  );
});

check("segment boundaries land within 400 ms of the real changes", () => {
  [0, 2, 4, 6].forEach((want, i) => {
    assert.ok(Math.abs(chart[i].t - want) < 0.4,
      `segment ${i} at ${chart[i].t.toFixed(2)}s, expected ${want}s`);
  });
});

check("the causal decoder agrees with the offline one", () => {
  // They must not disagree about WHAT is playing — only about when they can
  // say so. A disagreement means the two scorers have drifted apart.
  const causal = analysed.events.filter((e) => e.root >= 0)
    .map((e) => CF.chordName({ root: e.root, quality: e.quality }));
  const offline = chart.map((c) => CF.chordName(c));
  const overlap = causal.filter((c) => offline.includes(c)).length;
  assert.ok(overlap >= Math.min(causal.length, offline.length) - 1,
    `causal said [${causal.join(" ")}], offline said [${offline.join(" ")}]`);
});

check("estimates the key of a I-V-vi-IV in C", () => {
  const key = CF.estimateKey(CD.aggregateChroma(analysed.frames));
  // C major and A minor share a signature; either reading is defensible for
  // this progression, and both spell the chart identically.
  const ok = (key.pc === 0 && key.mode === "maj") || (key.pc === 9 && key.mode === "min");
  assert.ok(ok, `estimated ${CF.keyName(key)}`);
});

console.log("\npitch-shifted upload");

check("a track tuned to A=432 still decodes to the same chords", () => {
  // A meaningful share of YouTube uploads are pitch-shifted to dodge Content
  // ID. Without tuning compensation the whole chart comes out transposed, which
  // is the worst kind of wrong: internally consistent and unusable.
  const shifted = analyse(buildProgression(432));
  const shiftedChart = CD.decode(shifted.frames);
  const names = shiftedChart.map((c) => CF.chordName(c));
  assert.deepStrictEqual(names, ["C", "G", "Am", "F"],
    `got [${names.join(" ")}]; tuning estimate was ${shifted.tuning.toFixed(3)} semitones`);
});

console.log("\nsilence");

check("silence produces no chart", () => {
  const quiet = analyse(new Float32Array(SR * 4));
  assert.deepStrictEqual(CD.decode(quiet.frames), [],
    "silence must not yield chords — a chart that invents them is worse than none");
});

console.log("");
if (failures) {
  console.error(`${failures} pipeline check(s) failed`);
  process.exit(1);
}
console.log("chord pipeline OK");
