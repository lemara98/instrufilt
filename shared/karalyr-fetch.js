// Karalyr chord charts — first-party, and therefore first in line.
//
// Karalyr's worker analyzes songs the operator processes (lyrics + chords in
// one pass) and serves the chart at GET /api/chords, keyed by the same video
// identity the lyrics lookup uses. Unlike Songle these charts carry no terms:
// they are the family's own data, redistributable, attribution-free, with
// honest per-chord confidence — which is why karalyrProvider outranks
// songleProvider in shared/chord-source.js.
//
// Loaded by the service worker via importScripts(), same reasoning as
// lyrics-fetch.js: the SW fetches cross-origin under host_permissions and
// outlives the panel.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltKaralyrFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CF = () => globalThis.InstrufiltChordFormat;
  const CS = () => globalThis.InstrufiltChordSource;

  const DEFAULT_KARALYR_BASE = "https://www.karalyr.com";
  // Same rationale as the lyrics chain: a dead server must fail fast and
  // fall through, not stall the chart.
  const KARALYR_TIMEOUT_MS = 1500;
  const MIN_CHORDS = 4;
  const MAX_MALFORMED_FRACTION = 0.3;

  let karalyrBase = DEFAULT_KARALYR_BASE;
  function setKaralyrBase(base) {
    karalyrBase = base || DEFAULT_KARALYR_BASE;
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * /api/chords response -> a stored chart, or null when not worth trusting.
   * Pure; fixture-testable. The response's `chords` is the karalyr chart
   * payload: {format_version: 1, segments: [{start_ms, end_ms, label,
   * root_pc, quality, ext?, bass_pc?, confidence}], meta: {...}}.
   */
  function mapResponse(json, videoKey, durationSec) {
    const chart = json && json.chords;
    if (!chart || chart.format_version !== 1 || !Array.isArray(chart.segments)) return null;
    if (!chart.segments.length) return null;

    let malformed = 0;
    const parsed = [];
    for (const seg of chart.segments) {
      if (
        !seg ||
        typeof seg.start_ms !== "number" ||
        typeof seg.root_pc !== "number" || seg.root_pc < 0 || seg.root_pc > 11 ||
        (seg.quality !== 0 && seg.quality !== 1)
      ) {
        malformed++;
        continue;
      }
      const chord = {
        t: seg.start_ms / 1000,
        root: seg.root_pc,
        quality: seg.quality,
        // Confidence passes through UNCHANGED — this is a machine estimate
        // and the panel's low-confidence styling is supposed to fire on it,
        // unlike Songle's published transcriptions.
        confidence: typeof seg.confidence === "number"
          ? Math.max(0, Math.min(1, seg.confidence))
          : 0.7,
      };
      if (typeof seg.ext === "string" && seg.ext) chord.ext = seg.ext;
      if (typeof seg.bass_pc === "number" && seg.bass_pc >= 0 && seg.bass_pc <= 11) {
        chord.bass = seg.bass_pc;
      }
      parsed.push(chord);
    }

    if (parsed.length < MIN_CHORDS) return null;
    if (malformed / (malformed + parsed.length) > MAX_MALFORMED_FRACTION) return null;
    parsed.sort((a, b) => a.t - b.t);

    // The server already collapses repeats; be defensive about it anyway —
    // the renderer draws one symbol per change.
    const chords = [];
    for (const c of parsed) {
      const prev = chords[chords.length - 1];
      if (prev && prev.root === c.root && prev.quality === c.quality
          && prev.ext === c.ext && prev.bass === c.bass) continue;
      chords.push(c);
    }
    if (chords.length < MIN_CHORDS) return null;

    // The server estimated the key from the full audio — better information
    // than any client-side reconstruction, so honor it; fall back to the
    // pseudo-chromagram trick only when it is absent.
    const meta = chart.meta || {};
    let key = null;
    if (typeof meta.key_pc === "number" && (meta.key_mode === "maj" || meta.key_mode === "min")) {
      key = {
        pc: meta.key_pc,
        mode: meta.key_mode,
        confidence: typeof meta.key_confidence === "number" ? meta.key_confidence : 0.5,
      };
    } else if (CF()) {
      const chroma = new Array(12).fill(0);
      for (const c of chords) {
        chroma[c.root] += 1;
        chroma[(c.root + (c.quality === 1 ? 3 : 4)) % 12] += 0.75;
        chroma[(c.root + 7) % 12] += 0.6;
      }
      key = CF().estimateKey(chroma);
    }

    const lastEnd = chart.segments.reduce(
      (max, s) => (s && typeof s.end_ms === "number" ? Math.max(max, s.end_ms) : max), 0);
    const dur = Math.max(
      durationSec || 0,
      typeof meta.duration_ms === "number" ? meta.duration_ms / 1000 : 0,
      lastEnd / 1000
    );

    const source = CS();
    if (!source) return null;
    return source.makeChart({
      videoKey,
      durationSec: dur,
      tuning: 0,
      key,
      chords,
      covered: [[0, dur]],
      source: "karalyr",
    });
  }

  /**
   * @returns {Promise<object|null>} a stored-chart object, or null on any
   *          miss/failure — the provider chain falls through to Songle and
   *          the local detector.
   */
  async function fetchChart(videoKey, opts) {
    // Karalyr's identity family covers yt:/sp: exactly; generic host+path
    // keys 400 server-side, so don't send them.
    if (typeof videoKey !== "string") return null;
    let params;
    if (videoKey.startsWith("yt:")) params = "youtube_id=" + encodeURIComponent(videoKey.slice(3));
    else if (videoKey.startsWith("sp:")) params = "spotify_id=" + encodeURIComponent(videoKey.slice(3));
    else return null;

    try {
      const res = await fetchWithTimeout(`${karalyrBase}/api/chords?${params}`, KARALYR_TIMEOUT_MS);
      if (!res.ok) return null;
      const json = await res.json();
      return mapResponse(json, videoKey, opts && opts.durationSec);
    } catch {
      return null;
    }
  }

  return { fetchChart, mapResponse, setKaralyrBase, KARALYR_TIMEOUT_MS, DEFAULT_KARALYR_BASE };
});
