// Instrufilt — Songle chord parsing, response mapping, provider resolution
//
//   node test/songle-fetch.test.mjs
//
// Import order matters: chord-format and chord-source register the globals
// songle-fetch looks up lazily.

import assert from "node:assert";
import CF from "../shared/chord-format.js";
import CS from "../shared/chord-source.js";
import SF from "../shared/songle-fetch.js";

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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log("\nparseChordName");

check("triads", () => {
  assert.deepStrictEqual(SF.parseChordName("C"), { root: 0, quality: 0 });
  assert.deepStrictEqual(SF.parseChordName("Am"), { root: 9, quality: 1 });
  assert.deepStrictEqual(SF.parseChordName("F#m"), { root: 6, quality: 1 });
  assert.deepStrictEqual(SF.parseChordName("Bb"), { root: 10, quality: 0 });
});

check("sevenths — case separates minor from major-seventh", () => {
  assert.deepStrictEqual(SF.parseChordName("Gm7"), { root: 7, quality: 1, ext: "7" });
  assert.deepStrictEqual(SF.parseChordName("C7"), { root: 0, quality: 0, ext: "7" });
  assert.deepStrictEqual(SF.parseChordName("CM7"), { root: 0, quality: 0, ext: "M7" });
  assert.deepStrictEqual(SF.parseChordName("Cmaj7"), { root: 0, quality: 0, ext: "maj7" });
});

check("sus and slash chords", () => {
  assert.deepStrictEqual(SF.parseChordName("Bbsus4"), { root: 10, quality: 0, ext: "sus4" });
  assert.deepStrictEqual(SF.parseChordName("Eb/Ab"), { root: 3, quality: 0, bass: 8 });
  assert.deepStrictEqual(SF.parseChordName("Gm7/D"), { root: 7, quality: 1, ext: "7", bass: 2 });
});

check("N, garbage and non-notes are null", () => {
  assert.strictEqual(SF.parseChordName("N"), null);
  assert.strictEqual(SF.parseChordName(""), null);
  assert.strictEqual(SF.parseChordName("H7"), null);
  assert.strictEqual(SF.parseChordName("???"), null);
  assert.strictEqual(SF.parseChordName(null), null);
});

console.log("\nmapResponse");

// An F-major-ish progression the way Songle actually serialises one: leading
// N, per-bar repeats of the same chord, ms timestamps.
const FIXTURE = {
  chords: [
    { index: 0, start: 0,     duration: 1500, name: "N" },
    { index: 1, start: 1500,  duration: 2000, name: "F" },
    { index: 2, start: 3500,  duration: 2000, name: "F" },        // repeat -> collapsed
    { index: 3, start: 5500,  duration: 2000, name: "Bb" },
    { index: 4, start: 7500,  duration: 2000, name: "C7" },
    { index: 5, start: 9500,  duration: 2000, name: "Dm" },
    { index: 6, start: 11500, duration: 2000, name: "Bb" },
    { index: 7, start: 13500, duration: 2000, name: "F/A" },
    { index: 8, start: 15500, duration: 2333, name: "C7" },
  ],
};

check("maps ms to seconds and collapses repeats", () => {
  const chart = SF.mapResponse(FIXTURE, "yt:test1234567");
  assert.ok(chart, "expected a chart");
  const chords = CS.expandChords(chart);
  // 8 non-N entries, one repeat collapsed.
  assert.strictEqual(chords.length, 7);
  assert.strictEqual(chords[0].t, 1.5);
  assert.strictEqual(chords[0].root, 5);
  assert.strictEqual(chords[2].ext, "7");
  assert.strictEqual(chords[5].bass, 9);              // F/A
  assert.ok(chords.every((c) => c.confidence === 1), "verified data is full-confidence");
});

check("chart metadata: source, coverage, duration, key", () => {
  const chart = SF.mapResponse(FIXTURE, "yt:test1234567", 200);
  assert.strictEqual(chart.source, "songle");
  assert.strictEqual(chart.videoKey, "yt:test1234567");
  // duration is the larger of the media duration and the last segment's end.
  assert.strictEqual(chart.durationSec, 200);
  assert.deepStrictEqual(chart.covered, [[0, 200]]);
  assert.strictEqual(CS.coverageFraction(chart), 1);
  // F, Bb, C7, Dm is F major; and pc 10 must later spell Bb, not A#.
  assert.strictEqual(chart.keyPc, 5);
  assert.strictEqual(chart.keyMode, "maj");
});

check("labels round-trip through the real formatter", () => {
  const chart = SF.mapResponse(FIXTURE, "yt:test1234567");
  const key = { pc: chart.keyPc, mode: chart.keyMode };
  const labels = CF.labelChart(CS.expandChords(chart), { key }).map((c) => c.label);
  assert.deepStrictEqual(labels, ["F", "Bb", "C7", "Dm", "Bb", "F/A", "C7"]);
});

check("too few chords is a miss", () => {
  const tiny = { chords: FIXTURE.chords.slice(0, 4) };   // N + F + F + Bb -> 2 changes
  assert.strictEqual(SF.mapResponse(tiny, "yt:x"), null);
});

check("mostly-garbage responses are a miss, not a half-chart", () => {
  const garbled = {
    chords: FIXTURE.chords.map((c, i) =>
      i % 2 ? { ...c, name: "??" + i } : c),
  };
  assert.strictEqual(SF.mapResponse(garbled, "yt:x"), null);
});

check("empty and malformed input is safe", () => {
  assert.strictEqual(SF.mapResponse(null, "yt:x"), null);
  assert.strictEqual(SF.mapResponse({}, "yt:x"), null);
  assert.strictEqual(SF.mapResponse({ chords: [] }, "yt:x"), null);
  assert.strictEqual(SF.mapResponse({ chords: [{ bogus: true }] }, "yt:x"), null);
});

console.log("\nresolveChart ordering");

// A minimal chrome.storage.local fake so the cache provider and saveChart run.
function fakeChrome(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    _store: store,
    storage: {
      local: {
        async get(defaults) {
          const out = {};
          for (const [k, v] of Object.entries(defaults)) {
            out[k] = store.has(k) ? store.get(k) : v;
          }
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => store.delete(k)); },
      },
    },
  };
}

const KEY = "yt:abcdefghijk";
const localChart = CS.makeChart({
  videoKey: KEY, durationSec: 100, key: { pc: 0, mode: "maj", confidence: 0.5 },
  chords: [{ t: 1, root: 0, quality: 0, confidence: 0.6 }], covered: [[0, 60]],
});
const songleChart = SF.mapResponse(FIXTURE, KEY, 100);

await checkAsync("network off: cached local chart answers", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: localChart });
  globalThis.InstrufiltSongleFetch = { fetchChart: async () => { throw new Error("must not be called"); } };
  const got = await CS.resolveChart(KEY, { allowNetwork: false });
  assert.strictEqual(got.source, "cache");
  assert.strictEqual(got.chart.source, "local");
});

await checkAsync("network on: Songle upgrades a provisional local chart and persists", async () => {
  const chrome = fakeChrome({ [CS.storageKey(KEY)]: localChart });
  globalThis.chrome = chrome;
  globalThis.InstrufiltSongleFetch = { fetchChart: async () => songleChart };
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "songle");
  assert.strictEqual(chrome._store.get(CS.storageKey(KEY)).source, "songle",
    "the songle chart should replace the cached local one");
});

await checkAsync("network on, Songle miss: falls back to the cached local chart", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: localChart });
  globalThis.InstrufiltSongleFetch = { fetchChart: async () => null };
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "cache");
  assert.strictEqual(got.chart.source, "local");
});

await checkAsync("cached songle chart short-circuits — zero network on replays", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: songleChart });
  let called = 0;
  globalThis.InstrufiltSongleFetch = { fetchChart: async () => { called++; return null; } };
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "cache");
  assert.strictEqual(got.chart.source, "songle");
  assert.strictEqual(called, 0, "a cached songle chart must not re-fetch");
});

await checkAsync("non-YouTube keys never reach the fetcher", async () => {
  globalThis.chrome = fakeChrome({});
  globalThis.InstrufiltSongleFetch = SF;   // the real guard lives in fetchChart
  const got = await CS.resolveChart("sp:4uLU6hMCjMI75M1A2tKUQC", { allowNetwork: true });
  assert.strictEqual(got, null);
});

delete globalThis.chrome;
delete globalThis.InstrufiltSongleFetch;

console.log("");
if (failures) {
  console.error(`${failures} songle-fetch test(s) failed`);
  process.exit(1);
}
console.log("songle fetch OK");
