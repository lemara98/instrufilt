// Where a chord chart comes from.
//
// Resolution order is DATA, not code: adding a server means appending to
// PROVIDERS. Nothing downstream — not the offscreen accumulator, not the panel
// — ever learns which provider answered, beyond a label to show the user.
//
// Today there is one real provider (the local cache) and one stub. That is
// deliberate: the alternative is speculative infrastructure for a backend that
// does not exist yet, and this is one function plus a stub.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltChordSource = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CHART_VERSION = 1;
  const KEY_PREFIX = "chart:";
  const INDEX_KEY = "chart:index";
  const MAX_CHARTS = 200;

  function storageKey(videoKey) {
    return KEY_PREFIX + videoKey;
  }

  /**
   * A stored chart.
   *
   * chords are [t, root, quality, confidence] tuples rather than objects —
   * ~360 of them per song, and the array form is about a third of the JSON.
   * A chord from a verified external source may carry two more positions,
   * [.., ext, bass]: the quality suffix beyond the triad ("7", "sus4") and a
   * slash-chord bass pitch class (-1 = none). Old 4-tuples stay valid — the
   * extension is additive, so no CHART_VERSION bump.
   * `covered` records which spans of the song have actually been analysed, so a
   * half-listened song renders the half it knows and keeps going live for the
   * rest instead of pretending to be complete.
   */
  function makeChart({ videoKey, durationSec, tuning, key, chords, covered, source }) {
    return {
      v: CHART_VERSION,
      videoKey,
      durationSec: durationSec || 0,
      tuning: tuning || 0,
      keyPc: key ? key.pc : null,
      keyMode: key ? key.mode : null,
      keyConfidence: key ? key.confidence : 0,
      covered: covered || [],
      chords: (chords || []).map((c) => {
        const tuple = [round3(c.t), c.root, c.quality, round2(c.confidence || 0)];
        if (c.ext || typeof c.bass === "number") {
          tuple.push(c.ext || "", typeof c.bass === "number" ? c.bass : -1);
        }
        return tuple;
      }),
      analyzedAt: null,     // stamped by the caller; Date is unavailable here
      source: source || "local",
    };
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }
  function round2(x) { return Math.round(x * 100) / 100; }

  /** Stored tuple form -> objects the renderer wants. */
  function expandChords(chart) {
    if (!chart || !Array.isArray(chart.chords)) return [];
    return chart.chords.map(([t, root, quality, confidence, ext, bass]) => {
      const out = { t, root, quality, confidence };
      if (ext) out.ext = ext;
      if (typeof bass === "number" && bass >= 0) out.bass = bass;
      return out;
    });
  }

  /** Total analysed seconds, for the "how complete is this?" readout. */
  function coveredSeconds(chart) {
    if (!chart || !Array.isArray(chart.covered)) return 0;
    return chart.covered.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
  }

  function coverageFraction(chart) {
    if (!chart || !chart.durationSec) return 0;
    return Math.min(1, coveredSeconds(chart) / chart.durationSec);
  }

  /** Union of covered spans, merging anything that touches or overlaps. */
  function mergeCovered(spans) {
    const sorted = (spans || []).filter((s) => s && s[1] > s[0]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [a, b] of sorted) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 0.5) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  // ── providers ───────────────────────────────────────────────────────────

  async function cacheProvider(videoKey, opts) {
    try {
      const key = storageKey(videoKey);
      const got = await chrome.storage.local.get({ [key]: null });
      const chart = got[key];
      if (!chart || chart.v !== CHART_VERSION) return null;
      // "Provisional" means "usable, but keep looking; fall back to me if
      // nothing better answers". With the network on the table that covers a
      // cached LOCAL chart (a verified external chart beats a 55-65%
      // estimate) AND a cached SONGLE chart (first-party karalyr data
      // supersedes the third-party service — and stops accumulating
      // non-redistributable data). A cached KARALYR chart is final: replays
      // cost zero network.
      const provisional =
        !!(opts && opts.allowNetwork) &&
        (chart.source === "local" || chart.source === "songle");
      return { source: "cache", chart, provisional };
    } catch {
      return null;
    }
  }

  // Karalyr — the family's own worker analyzed this song alongside its
  // lyrics. First-party: redistributable, attribution-free, honest per-chord
  // confidence, slash-bass vocabulary. First in line for all of those
  // reasons. The fetch module is SW-only; anywhere it is not loaded this
  // degrades to null.
  async function karalyrProvider(videoKey, opts) {
    const KF = globalThis.InstrufiltKaralyrFetch;
    if (!KF) return null;
    const chart = await KF.fetchChart(videoKey, { durationSec: opts && opts.durationSec });
    return chart ? { source: "karalyr", chart } : null;
  }
  karalyrProvider.network = true;
  karalyrProvider.sourceName = "karalyr";

  // Songle (AIST) — verified, time-synced, non-commercial terms; the
  // fallback for everything Karalyr has not processed.
  //
  // REDISTRIBUTION FIREWALL: any "contribute your chart" path MUST exclude
  // charts with source "songle" — Songle's terms forbid redistributing their
  // data, and a per-user device cache is the most that is defensible.
  // (Server-side twin: karalyr's chord_charts source enum has no "songle"
  // member, so a mistaken upload fails validation there too.)
  async function songleProvider(videoKey, opts) {
    const SF = globalThis.InstrufiltSongleFetch;
    if (!SF) return null;
    const chart = await SF.fetchChart(videoKey, { durationSec: opts && opts.durationSec });
    return chart ? { source: "songle", chart } : null;
  }
  songleProvider.network = true;
  songleProvider.sourceName = "songle";

  const PROVIDERS = [cacheProvider, karalyrProvider, songleProvider];

  /**
   * First non-provisional answer wins; the first provisional one is kept as
   * the fallback for when nothing better answers. A fresh network chart is
   * persisted here so the next resolution is a plain cache hit.
   * @returns {Promise<{source:string, chart:object}|null>}
   */
  async function resolveChart(videoKey, opts) {
    if (!videoKey) return null;
    const allowNetwork = !!(opts && opts.allowNetwork);
    let fallback = null;
    for (const provider of PROVIDERS) {
      if (provider.network && !allowNetwork) continue;
      // Never re-query the provider whose own answer is already the fallback:
      // a cached songle chart goes provisional hoping karalyr answers, and
      // when karalyr misses it must be served from cache — not re-fetched
      // from Songle, which would be the same data as needless traffic against
      // a service we're guests of.
      if (fallback && provider.sourceName && fallback.chart.source === provider.sourceName) {
        continue;
      }
      const got = await provider(videoKey, opts);
      if (!got) continue;
      if (got.provisional) {
        if (!fallback) fallback = got;
        continue;
      }
      if (got.source !== "cache") await saveChart(got.chart);
      return got;
    }
    return fallback;
  }

  // ── persistence ─────────────────────────────────────────────────────────

  async function saveChart(chart) {
    if (!chart || !chart.videoKey) return;
    const key = storageKey(chart.videoKey);
    try {
      await chrome.storage.local.set({ [key]: chart });

      // LRU index. Without a bound, a heavy user accumulates charts until
      // storage.local's 10 MB quota starts rejecting writes — and a failed
      // write is silent, so the symptom would be "charts randomly stop saving".
      const { [INDEX_KEY]: index } = await chrome.storage.local.get({ [INDEX_KEY]: [] });
      const next = [chart.videoKey, ...index.filter((k) => k !== chart.videoKey)];
      const evicted = next.slice(MAX_CHARTS);
      if (evicted.length) {
        await chrome.storage.local.remove(evicted.map(storageKey));
      }
      await chrome.storage.local.set({ [INDEX_KEY]: next.slice(0, MAX_CHARTS) });
    } catch (err) {
      console.warn("[if] saveChart failed:", err && err.message);
    }
  }

  async function deleteChart(videoKey) {
    try {
      await chrome.storage.local.remove(storageKey(videoKey));
      const { [INDEX_KEY]: index } = await chrome.storage.local.get({ [INDEX_KEY]: [] });
      await chrome.storage.local.set({ [INDEX_KEY]: index.filter((k) => k !== videoKey) });
    } catch {}
  }

  return {
    resolveChart, saveChart, deleteChart, makeChart, expandChords,
    coveredSeconds, coverageFraction, mergeCovered,
    CHART_VERSION, MAX_CHARTS, INDEX_KEY, storageKey,
  };
});
