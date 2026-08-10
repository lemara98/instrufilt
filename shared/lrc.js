// LRC parsing — plain and Enhanced.
//
// Karafilt carries two copies of this: the full parser in
// content/lyrics-overlay.js:213 and a line-only version in
// sidepanel/sidepanel.js:326, so the panel can render an alternative without a
// content-script round trip. Instrufilt keeps one copy, loadable everywhere:
// <script> in the panel, content script, importScripts() in the service
// worker, and require()/import in Node tests.
//
// Enhanced LRC word tags matter more here than they do for karaoke. The
// lead-sheet phase places a chord on "the last word whose time <= chord.t",
// which is exact with measured word times and an equal-slice estimate without
// them — so word timing is the difference between a chord landing on the right
// syllable and landing near it.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltLRC = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LINE_RE = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
  const WORD_RE = /<(\d+):(\d+(?:[.:]\d+)?)>/g;

  // "02:15.30" and the occasional "02:15:30" both appear in the wild.
  function toSeconds(minutes, rest) {
    return parseInt(minutes, 10) * 60 + parseFloat(String(rest).replace(":", "."));
  }

  /**
   * Parse an LRC document into time-ordered lines.
   *
   * @param {string} lrc
   * @returns {Array<{time:number, text:string, words?:Array<{time:number,text:string}>}>}
   */
  function parseLRC(lrc) {
    const lines = [];
    if (!lrc || typeof lrc !== "string") return lines;

    for (const rawLine of lrc.split(/\r?\n/)) {
      // A line may carry several timestamps ("[00:12.00][01:44.00]chorus") —
      // each one emits its own entry.
      const timestamps = [];
      let m;
      LINE_RE.lastIndex = 0;
      while ((m = LINE_RE.exec(rawLine)) !== null) timestamps.push(toSeconds(m[1], m[2]));
      if (timestamps.length === 0) continue;

      // Strips metadata tags ([ar:], [ti:], [by:]) along with the timestamps.
      const rest = rawLine.replace(/\[[^\]]*\]/g, "");

      let words = null;
      WORD_RE.lastIndex = 0;
      if (WORD_RE.test(rest)) {
        words = [];
        WORD_RE.lastIndex = 0;
        let prev = null;
        // A word's text is everything between its own tag and the next one,
        // so each match closes the PREVIOUS word rather than opening its own.
        const closeWord = (endIdx) => {
          if (!prev) return;
          const t = rest.slice(prev.end, endIdx).trim();
          if (t) words.push({ time: prev.time, text: t });
        };
        let w;
        while ((w = WORD_RE.exec(rest)) !== null) {
          closeWord(w.index);
          prev = { time: toSeconds(w[1], w[2]), end: WORD_RE.lastIndex };
        }
        closeWord(rest.length);
        if (words.length === 0) words = null;
      }

      const text = rest.replace(WORD_RE, "").replace(/\s+/g, " ").trim();
      if (!text) continue;

      for (const t of timestamps) {
        lines.push(words ? { time: t, text, words } : { time: t, text });
      }
    }

    // Multi-timestamp lines and out-of-order files both land here unsorted,
    // and syncToPlaybackTime binary-searches this array.
    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  /** True if any line carries measured word timing. */
  function hasWordTiming(lines) {
    return !!(lines && lines.some((l) => l.words && l.words.length > 0));
  }

  // Instrumental gaps. Karafilt shows a count-in here; for Instrufilt these
  // are the intros, solos and breakdowns — the stretches a musician is
  // actually playing through, and where the chord row earns its keep.
  const GAP_MIN_SECONDS = 5;
  const GAP_WORD_TAIL_SECONDS = 1.2;

  /**
   * @returns {Array<{start:number, end:number, nextIndex:number}>}
   */
  function computeGaps(lines) {
    const gaps = [];
    if (!lines || lines.length === 0) return gaps;

    if (lines[0].time > GAP_MIN_SECONDS) {
      gaps.push({ start: 0, end: lines[0].time, nextIndex: 0 });
    }

    for (let i = 0; i < lines.length - 1; i++) {
      // Mid-song gaps need word timing: a plain LRC line carries only its
      // START, so there is no way to know when the singing actually stopped.
      // Without this guard every long line would read as a gap.
      const words = lines[i].words;
      if (!words || words.length === 0) continue;
      const lastTime = words[words.length - 1].time;
      if (typeof lastTime !== "number") continue;
      const end = lastTime + GAP_WORD_TAIL_SECONDS;
      if (lines[i + 1].time - end > GAP_MIN_SECONDS) {
        gaps.push({ start: end, end: lines[i + 1].time, nextIndex: i + 1 });
      }
    }
    return gaps;
  }

  /**
   * Index of the last line at or before `t`, or -1. Stateless binary search
   * over absolute time, which is what makes seeking free: there is no cursor
   * to invalidate, so a seek self-corrects on the next tick.
   */
  function lineIndexAt(lines, t) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) { found = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return found;
  }

  return {
    parseLRC,
    hasWordTiming,
    computeGaps,
    lineIndexAt,
    GAP_MIN_SECONDS,
    GAP_WORD_TAIL_SECONDS,
  };
});
