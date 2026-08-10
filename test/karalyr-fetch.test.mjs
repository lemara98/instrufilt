// Instrufilt — Karalyr chord-chart mapping and provider resolution order
//
//   node test/karalyr-fetch.test.mjs
//
// Import order matters: chord-format and chord-source register the globals
// karalyr-fetch looks up lazily.

import assert from "node:assert";
import CF from "../shared/chord-format.js";
import CS from "../shared/chord-source.js";
import SF from "../shared/songle-fetch.js";
import KF from "../shared/karalyr-fetch.js";

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

console.log("\nmapResponse");

// A /api/chords response the way the server actually shapes one.
const FIXTURE = {
  track_id: 7,
  trackName: "Fixture Song",
  artistName: "Fixture Artist",
  duration: 200,
  chords: {
    format_version: 1,
    segments: [
      { start_ms: 1000, end_ms: 3000, label: "C:maj", root_pc: 0, quality: 0, confidence: 0.9 },
      { start_ms: 3000, end_ms: 5000, label: "A:min7", root_pc: 9, quality: 1, ext: "7", confidence: 0.8 },
      { start_ms: 5000, end_ms: 7000, label: "F:maj/5", root_pc: 5, quality: 0, bass_pc: 0, confidence: 0.85 },
      // adjacent duplicate — must collapse
      { start_ms: 7000, end_ms: 8000, label: "F:maj/5", root_pc: 5, quality: 0, bass_pc: 0, confidence: 0.85 },
      { start_ms: 8000, end_ms: 11000, label: "G:7", root_pc: 7, quality: 0, ext: "7", confidence: 0.4 },
    ],
    meta: {
      model: "lv-chordia-ensemble", dict: "submission",
      key_pc: 0, key_mode: "maj", key_confidence: 0.7,
      analyzed_from: "original_mix", duration_ms: 200000,
    },
  },
  karalyr: { chart_id: 3, tier: "auto_aligned", source: "auto_detected", created_at: 1 },
};

check("maps segments to tuples with ext/bass and honest confidence", () => {
  const chart = KF.mapResponse(FIXTURE, "yt:abc123def45");
  assert.ok(chart, "expected a chart");
  assert.strictEqual(chart.source, "karalyr");
  const chords = CS.expandChords(chart);
  assert.strictEqual(chords.length, 4, "adjacent duplicate must collapse");
  assert.strictEqual(chords[0].t, 1);
  assert.strictEqual(chords[1].ext, "7");
  assert.strictEqual(chords[2].bass, 0);
  // NOT coerced to 1 — the low-confidence styling should fire on 0.4.
  assert.strictEqual(chords[3].confidence, 0.4);
});

check("honors the server's key and duration", () => {
  const chart = KF.mapResponse(FIXTURE, "yt:abc123def45", 180);
  assert.strictEqual(chart.keyPc, 0);
  assert.strictEqual(chart.keyMode, "maj");
  assert.strictEqual(chart.durationSec, 200);            // meta.duration_ms wins over 180
  assert.deepStrictEqual(chart.covered, [[0, 200]]);
  assert.strictEqual(CS.coverageFraction(chart), 1);
});

check("falls back to a client key estimate when the server has none", () => {
  const noKey = JSON.parse(JSON.stringify(FIXTURE));
  noKey.chords.meta.key_pc = null;
  noKey.chords.meta.key_mode = null;
  const chart = KF.mapResponse(noKey, "yt:abc123def45");
  assert.ok(chart.keyPc !== null, "expected an estimated key");
});

check("labels round-trip through the real formatter", () => {
  const chart = KF.mapResponse(FIXTURE, "yt:abc123def45");
  const key = { pc: chart.keyPc, mode: chart.keyMode };
  const labels = CF.labelChart(CS.expandChords(chart), { key }).map((c) => c.label);
  assert.deepStrictEqual(labels, ["C", "Am7", "F/C", "G7"]);
});

check("misses: too few chords, malformed floods, wrong version, junk", () => {
  const tiny = JSON.parse(JSON.stringify(FIXTURE));
  tiny.chords.segments = tiny.chords.segments.slice(0, 2);
  assert.strictEqual(KF.mapResponse(tiny, "yt:x"), null);

  const garbled = JSON.parse(JSON.stringify(FIXTURE));
  garbled.chords.segments = garbled.chords.segments.concat([
    { start_ms: "nope" }, { root_pc: 99 }, {},
  ]);
  assert.strictEqual(KF.mapResponse(garbled, "yt:x"), null, ">30% malformed is a miss");

  const v2 = JSON.parse(JSON.stringify(FIXTURE));
  v2.chords.format_version = 2;
  assert.strictEqual(KF.mapResponse(v2, "yt:x"), null);

  assert.strictEqual(KF.mapResponse(null, "yt:x"), null);
  assert.strictEqual(KF.mapResponse({}, "yt:x"), null);
  assert.strictEqual(KF.mapResponse({ chords: { format_version: 1, segments: [] } }, "yt:x"), null);
});

console.log("\nresolveChart ordering — karalyr first, songle fallback");

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
const karalyrChart = KF.mapResponse(FIXTURE, KEY, 100);
const songleChart = CS.makeChart({
  videoKey: KEY, durationSec: 100, key: { pc: 0, mode: "maj", confidence: 0.5 },
  chords: [{ t: 1, root: 7, quality: 0, confidence: 1 }, { t: 3, root: 0, quality: 0, confidence: 1 },
           { t: 5, root: 9, quality: 1, confidence: 1 }, { t: 7, root: 5, quality: 0, confidence: 1 }],
  covered: [[0, 100]], source: "songle",
});

function stubFetchers({ karalyr = null, songle = null } = {}) {
  const calls = { karalyr: 0, songle: 0 };
  globalThis.InstrufiltKaralyrFetch = {
    fetchChart: async () => { calls.karalyr++; return karalyr; },
  };
  globalThis.InstrufiltSongleFetch = {
    fetchChart: async () => { calls.songle++; return songle; },
  };
  return calls;
}

await checkAsync("karalyr answers before songle is ever contacted", async () => {
  globalThis.chrome = fakeChrome({});
  const calls = stubFetchers({ karalyr: karalyrChart, songle: songleChart });
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "karalyr");
  assert.strictEqual(calls.songle, 0, "songle must not be contacted on a karalyr hit");
});

await checkAsync("karalyr miss falls through to songle", async () => {
  globalThis.chrome = fakeChrome({});
  const calls = stubFetchers({ karalyr: null, songle: songleChart });
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "songle");
  assert.strictEqual(calls.karalyr, 1);
});

await checkAsync("cached songle chart is provisional: karalyr hit supersedes and persists", async () => {
  const chrome = fakeChrome({ [CS.storageKey(KEY)]: songleChart });
  globalThis.chrome = chrome;
  stubFetchers({ karalyr: karalyrChart });
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "karalyr");
  assert.strictEqual(chrome._store.get(CS.storageKey(KEY)).source, "karalyr",
    "the karalyr chart should replace the cached songle one");
});

await checkAsync("cached songle + karalyr miss: served from cache, songle NOT re-fetched", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: songleChart });
  const calls = stubFetchers({ karalyr: null, songle: songleChart });
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "cache");
  assert.strictEqual(got.chart.source, "songle");
  assert.strictEqual(calls.songle, 0, "the fallback IS songle's answer - no refetch");
});

await checkAsync("cached karalyr chart is final: zero network on replays", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: karalyrChart });
  const calls = stubFetchers({ karalyr: karalyrChart, songle: songleChart });
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "cache");
  assert.strictEqual(got.chart.source, "karalyr");
  assert.strictEqual(calls.karalyr + calls.songle, 0);
});

await checkAsync("cached local + both miss: local chart still serves", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: localChart });
  stubFetchers({ karalyr: null, songle: null });
  const got = await CS.resolveChart(KEY, { allowNetwork: true });
  assert.strictEqual(got.source, "cache");
  assert.strictEqual(got.chart.source, "local");
});

await checkAsync("network off: cache only, no fetchers touched", async () => {
  globalThis.chrome = fakeChrome({ [CS.storageKey(KEY)]: songleChart });
  const calls = stubFetchers({ karalyr: karalyrChart, songle: songleChart });
  const got = await CS.resolveChart(KEY, { allowNetwork: false });
  assert.strictEqual(got.chart.source, "songle");
  assert.strictEqual(calls.karalyr + calls.songle, 0);
});

console.log("\nfetchChart key guards");

await checkAsync("generic host+path keys never reach the network", async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("no"); };
  const got = await KF.fetchChart("somehost.com/path", {});
  assert.strictEqual(got, null);
  assert.strictEqual(fetched, false);
  delete globalThis.fetch;
});

delete globalThis.chrome;
delete globalThis.InstrufiltKaralyrFetch;
delete globalThis.InstrufiltSongleFetch;

console.log("");
if (failures) {
  console.error(`${failures} karalyr-fetch test(s) failed`);
  process.exit(1);
}
console.log("karalyr fetch OK");
