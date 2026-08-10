// Instrufilt — WASM ABI contract
//
//   node test/wasm-abi.test.mjs
//
// worklet-processor.js calls into the WASM by name. Nothing checks those names:
// not the C compiler, not emcc, not the linker. A function renamed in C or
// dropped from EXPORTED_FUNCTIONS in the Makefile surfaces as
// "this.exports.isolate_set_mode is not a function", thrown on the audio
// thread, inside an AudioWorklet, where the console message is easy to miss and
// the only symptom is that a control silently stops working.
//
// This instantiates the real artifact and asserts the seam, then runs enough
// audio through it to prove the build is not merely well-formed but correct —
// the native suite (wasm/test/iso_test.c) proves the algorithm, this proves the
// thing actually shipped to the browser behaves the same way.

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const WASM = path.join(ROOT, "wasm/build/vocal_isolate.wasm");

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

console.log("\nwasm ABI");

if (!existsSync(WASM)) {
  console.log("  skip  wasm/build/vocal_isolate.wasm not built — run `make`");
  process.exit(0);
}

// Every name worklet-processor.js reaches for, and where.
const REQUIRED = {
  isolate_init: "_initWasm",
  isolate_process: "process()",
  isolate_get_input_l: "_initWasm view setup",
  isolate_get_input_r: "_initWasm view setup",
  isolate_get_output_l: "_initWasm view setup",
  isolate_get_output_r: "_initWasm view setup",
  isolate_set_amount: "SET_AMOUNT",
  isolate_set_mode: "SET_MODE",
  isolate_set_makeup_db: "SET_MAKEUP_DB",
  isolate_set_auto_gain: "SET_AUTO_GAIN",
  isolate_set_mono: "SET_MONO",
  isolate_set_repet: "SET_REPET + _initWasm seeding",
  isolate_repet_reset: "RESET_REPET",
  isolate_latency_samples: "WORKLET_READY message",
};

const module = new WebAssembly.Module(readFileSync(WASM));

// Mirrors the worklet's import-variant probing.
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
assert.ok(instance, "WASM would not instantiate with either import variant the worklet tries");
const x = instance.exports;

for (const [name, usedBy] of Object.entries(REQUIRED)) {
  check(`exports ${name}()`, () =>
    assert.strictEqual(typeof x[name], "function", `missing — called from worklet-processor.js ${usedBy}`));
}

check("exports memory", () =>
  assert.ok(x.memory instanceof WebAssembly.Memory, "the worklet builds Float32Array views over this"));

// ALLOW_MEMORY_GROWTH=0 is load-bearing: the worklet builds its views exactly
// once, so a growable heap would detach them and emit silent garbage.
check("heap is NOT growable (views must never detach)", () => {
  const before = x.memory.buffer.byteLength;
  let grew = false;
  try { x.memory.grow(1); grew = x.memory.buffer.byteLength > before; } catch { grew = false; }
  assert.ok(!grew, "heap grew — worklet-processor.js:_updateViews runs once and its views would detach");
});

console.log("\nbehaviour of the shipped artifact");

const SR = 48000;
const BLOCK = 128;
const LAT = 2048;

// repet defaults to 0: every check below except the REPET one is about the pan
// mask, and REPET would confound them by suppressing the steady test tones they
// are built from. Mirrors reset() in wasm/test/iso_test.c.
function run({ mode = 1, amount = 1, makeupDb = 0, samples, panned = false, repet = 0 }) {
  x.isolate_init(SR);
  x.isolate_set_mode(mode);
  x.isolate_set_amount(amount);
  x.isolate_set_makeup_db(makeupDb);
  x.isolate_set_auto_gain(0);
  x.isolate_set_mono(0);
  x.isolate_set_repet(repet);

  const buf = x.memory.buffer;
  const inL = new Float32Array(buf, x.isolate_get_input_l(), BLOCK);
  const inR = new Float32Array(buf, x.isolate_get_input_r(), BLOCK);
  const outL = new Float32Array(buf, x.isolate_get_output_l(), BLOCK);

  const out = new Float32Array(samples.length);
  for (let off = 0; off + BLOCK <= samples.length; off += BLOCK) {
    for (let i = 0; i < BLOCK; i++) {
      inL[i] = samples[off + i];
      inR[i] = panned ? 0 : samples[off + i];
    }
    x.isolate_process(BLOCK);
    out.set(outL, off);
  }
  return out;
}

function tone(hz, amp, n) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return s;
}

function rms(a, from) {
  let s = 0, n = 0;
  for (let i = from; i < a.length; i++) { s += a[i] * a[i]; n++; }
  return Math.sqrt(s / n);
}

const N = 65536;
const SETTLE = LAT + 16384;

check("latency reports 2048 samples", () =>
  assert.strictEqual(x.isolate_latency_samples(), LAT));

check("amount=0 is a bit-exact passthrough delayed by 2048", () => {
  const input = tone(440, 0.4, N);
  const out = run({ amount: 0, samples: input });
  let worst = 0;
  for (let i = LAT; i < N; i++) worst = Math.max(worst, Math.abs(out[i] - input[i - LAT]));
  assert.strictEqual(worst, 0, `max deviation ${worst.toExponential(2)}`);
});

check("centred 1kHz survives in VOCAL_ONLY", () => {
  const input = tone(1000, 0.5, N);
  const ratio = rms(run({ mode: 0, samples: input }), SETTLE) / rms(input, SETTLE);
  assert.ok(ratio > 0.7, `ratio ${ratio.toFixed(3)} — the mask is rejecting a centred vocal`);
});

check("hard-panned 1kHz is removed in VOCAL_ONLY", () => {
  const input = tone(1000, 0.5, N);
  const out = run({ mode: 0, samples: input, panned: true });
  const ratio = rms(out, SETTLE) / rms(input, SETTLE);
  assert.ok(ratio < 0.25, `ratio ${ratio.toFixed(3)} — panned content is leaking through`);
});

check("centred 60Hz removed in VOCAL_ONLY, kept in VOCAL_RHYTHM", () => {
  const input = tone(60, 0.5, N);
  const only = rms(run({ mode: 0, samples: input }), SETTLE) / rms(input, SETTLE);
  const rhythm = rms(run({ mode: 1, samples: input }), SETTLE) / rms(input, SETTLE);
  assert.ok(only < 0.2, `VOCAL_ONLY kept bass at ${only.toFixed(3)} — out-of-band bins not zeroed`);
  assert.ok(rhythm > 0.7, `VOCAL_RHYTHM dropped bass to ${rhythm.toFixed(3)} — the groove is gone`);
});

// The algorithm is proved in wasm/test/iso_test.c; what this proves is that the
// stage is alive in the artifact the browser actually loads. A steady centred
// tone is the most repetitive signal there is, so REPET must remove it — and
// with the stage off the very same tone must survive, which is the check above.
check("REPET suppresses a steady centred tone once warmed up", () => {
  const long = 8 * SR;                     // ~3 s warm-up, then 5 s of measurement
  const input = tone(1000, 0.5, long);
  const from = 5 * SR;
  const off = rms(run({ mode: 0, samples: input, repet: 0 }).subarray(from), 0);
  const on = rms(run({ mode: 0, samples: input, repet: 1 }).subarray(from), 0);
  assert.ok(on < off * 0.5,
    `stage-on ${on.toFixed(4)} vs stage-off ${off.toFixed(4)} — REPET is not running in the wasm build`);
});

check("isolate_repet_reset() is callable and leaves the graph running", () => {
  const input = tone(1000, 0.5, 4 * SR);
  x.isolate_repet_reset();
  const out = run({ mode: 0, samples: input, repet: 1 });
  assert.ok(out.every(Number.isFinite), "non-finite output after a reset");
});

check("no NaN or Inf on a full-scale square wave", () => {
  const s = new Float32Array(N);
  for (let i = 0; i < N; i++) s[i] = (i / 64) % 2 < 1 ? 1 : -1;
  const out = run({ samples: s, makeupDb: 18 });
  const bad = out.findIndex((v) => !Number.isFinite(v));
  assert.strictEqual(bad, -1, `non-finite output at sample ${bad}`);
});

check("output never exceeds full scale at +18dB makeup", () => {
  const out = run({ mode: 0, samples: tone(1000, 1.0, N), makeupDb: 18 });
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 1.0, `peak ${peak.toFixed(5)}`);
});

console.log("");
if (failures) {
  console.error(`${failures} ABI check(s) failed`);
  process.exit(1);
}
console.log("wasm ABI OK");
