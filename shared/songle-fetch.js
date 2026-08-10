// Songle chord charts — the one third-party source of TIME-SYNCED chords.
//
// Songle (https://songle.jp) is an academic music-understanding service run by
// AIST in Japan. Its widget API returns millisecond chord segments for a
// YouTube URL, with a vocabulary the local detector cannot reach (7ths, sus,
// slash chords). Loaded by the service worker via importScripts(), same
// reasoning as lyrics-fetch.js: host_permissions let the SW fetch cross-origin,
// and it outlives the panel.
//
// TERMS THAT SHAPE THIS FILE — from api.songle.jp/terms_of_use.pdf:
//   * Non-commercial use only. Instrufilt is free and stays free; if that ever
//     changes this provider must be removed or renegotiated.
//   * No redistribution. A per-user device cache (chrome.storage.local) is the
//     most that is defensible. Charts with source "songle" must NEVER be
//     uploaded anywhere — not to Karalyr, not as a community contribution.
//   * Visible attribution. The panel shows "Chords: Songle (AIST)" whenever a
//     Songle chart is on screen; removing that credit breaks the terms.
//   * The service is research infrastructure and may change or vanish without
//     notice — every failure path here returns null so the caller falls
//     through to the on-device detector.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltSongleFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Lazy lookups, not load-order dependencies: in contexts where these are not
  // loaded (Node test of just this file), the pure parsers still work.
  const CF = () => globalThis.InstrufiltChordFormat;
  const CS = () => globalThis.InstrufiltChordSource;

  const SONGLE_BASE = "https://widget.songle.jp/api/v1/song/chord.json";
  // Same rationale as KARALYR_TIMEOUT_MS: a dead server must fail fast and
  // fall through to the local detector, not stall the chart for 30s.
  const SONGLE_TIMEOUT_MS = 1500;
  // Below this the "chart" is a fragment; above this fraction of garbage the
  // whole response is suspect. Either way the local detector does better.
  const MIN_CHORDS = 4;
  const MAX_UNPARSEABLE_FRACTION = 0.3;

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
   * "Gm7" -> {root:7, quality:1, ext:"7"}; "Eb/Ab" -> {root:3, quality:0,
   * bass:8}; "N" (no chord) and anything unreadable -> null.
   *
   * Minor iff the suffix starts with a LOWERCASE m that is not "maj" — Songle
   * writes "Cm7" for the minor seventh and "CM7"/"Cmaj7" for the major
   * seventh, and case is the only thing separating them.
   */
  function parseChordName(name) {
    if (typeof name !== "string" || !name || name === "N") return null;
    const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(name);
    if (!m) return null;
    const fmt = CF();
    const root = fmt ? fmt.noteToPc(m[1]) : null;
    if (root === null) return null;

    let rest = m[2] || "";
    let quality = 0;
    if (rest[0] === "m" && !rest.startsWith("maj")) {
      quality = 1;
      rest = rest.slice(1);
    }

    const out = { root, quality };
    if (rest) out.ext = rest;
    if (m[3]) {
      const bass = fmt.noteToPc(m[3]);
      if (bass !== null) out.bass = bass;
    }
    return out;
  }

  /**
   * Songle response -> a stored chart, or null when the response is not worth
   * trusting. Pure; fixture-testable.
   *
   * @param {{chords?:Array<{start:number,duration:number,name:string}>}} json
   * @param {string} videoKey
   * @param {number} [durationSec]  the media element's duration, if known
   */
  function mapResponse(json, videoKey, durationSec) {
    if (!json || !Array.isArray(json.chords) || !json.chords.length) return null;

    const entries = json.chords
      .filter((c) => c && typeof c.start === "number" && typeof c.name === "string")
      .sort((a, b) => a.start - b.start);

    let unparseable = 0;
    let lastEndMs = 0;
    const parsed = [];
    for (const entry of entries) {
      const endMs = entry.start + (typeof entry.duration === "number" ? entry.duration : 0);
      if (endMs > lastEndMs) lastEndMs = endMs;
      if (entry.name === "N") continue;          // a break, not a chord to show
      const chord = parseChordName(entry.name);
      if (!chord) { unparseable++; continue; }
      parsed.push({ ...chord, t: entry.start / 1000, durMs: Math.max(0, entry.duration || 0) });
    }

    if (parsed.length < MIN_CHORDS) return null;
    if (unparseable / (unparseable + parsed.length) > MAX_UNPARSEABLE_FRACTION) return null;

    // Songle segments per beat/bar, so the same chord repeats back to back.
    // The renderer draws one symbol per CHANGE; collapse repeats, keeping the
    // first onset.
    const chords = [];
    for (const c of parsed) {
      const prev = chords[chords.length - 1];
      if (prev && prev.root === c.root && prev.quality === c.quality
          && prev.ext === c.ext && prev.bass === c.bass) continue;
      chords.push(c);
    }
    if (chords.length < MIN_CHORDS) return null;

    // Key from a pseudo-chromagram: each chord votes root+third+fifth (+bass),
    // weighted by how long it sounds. Cheap, and it is what buys correct flat
    // spelling — Bb in F major, never A#.
    const chroma = new Array(12).fill(0);
    for (const c of parsed) {
      const w = (c.durMs || 500) / 1000;
      chroma[c.root] += w;
      chroma[(c.root + (c.quality === 1 ? 3 : 4)) % 12] += 0.75 * w;
      chroma[(c.root + 7) % 12] += 0.6 * w;
      if (typeof c.bass === "number") chroma[c.bass] += 0.3 * w;
    }
    const key = CF() ? CF().estimateKey(chroma) : null;

    const dur = Math.max(durationSec || 0, lastEndMs / 1000);
    const source = CS();
    if (!source) return null;
    const chart = source.makeChart({
      videoKey,
      durationSec: dur,
      tuning: 0,
      key,
      // Confidence 1: this is a published transcription, not an estimate, and
      // the is-low-confidence styling should never fire on it.
      chords: chords.map((c) => ({
        t: c.t, root: c.root, quality: c.quality, confidence: 1, ext: c.ext, bass: c.bass,
      })),
      // The whole song is covered by definition — the coverage readout is
      // about how much the LOCAL detector has heard, and does not apply here.
      covered: [[0, dur]],
      source: "songle",
    });
    return chart;
  }

  /**
   * @param {string} videoKey
   * @param {{durationSec?:number}} [opts]
   * @returns {Promise<object|null>}  a stored-chart object, or null on any
   *          miss/failure — silence is the contract, the local detector is
   *          always behind this.
   */
  async function fetchChart(videoKey, opts) {
    // Songle indexes by media URL and only YouTube keys can be turned back
    // into one. Spotify and generic keys stay on the local detector.
    if (typeof videoKey !== "string" || !videoKey.startsWith("yt:")) return null;
    const watchUrl = "https://www.youtube.com/watch?v=" + videoKey.slice(3);
    const url = SONGLE_BASE + "?url=" + encodeURIComponent(watchUrl);
    try {
      const res = await fetchWithTimeout(url, SONGLE_TIMEOUT_MS);
      if (!res.ok) return null;
      const json = await res.json();
      return mapResponse(json, videoKey, opts && opts.durationSec);
    } catch {
      return null;
    }
  }

  return { fetchChart, mapResponse, parseChordName, SONGLE_TIMEOUT_MS };
});
