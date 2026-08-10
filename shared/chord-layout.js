// Where does a chord go on a lyric line?
//
// Pure, DOM-free, Node-testable. Kept out of leadsheet.js because this is the
// part with real edge cases — a chord landing on the wrong syllable is the most
// visible way a lead sheet can be wrong, and it is much easier to get right
// against assertions than against a screenshot.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltChordLayout = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LAST_LINE_TAIL_SECONDS = 4;

  function wordCountOf(line) {
    if (line.words && line.words.length) return line.words.length;
    return Math.max(1, String(line.text || "").split(/\s+/).filter(Boolean).length);
  }

  /**
   * Map chords onto word indices for one line.
   *
   * Two regimes:
   *
   *   Word-timed lyrics — exact. The chord goes on the last word that had
   *   already started when the chord landed.
   *
   *   Line-timed only — the same equal-slice estimate the word-highlight sweep
   *   already makes. That is deliberate. The estimate is wrong in the same
   *   direction and by the same amount as the sweep, so the chord and the
   *   highlighted word stay consistent with each other. A chord that disagrees
   *   with the sweep looks broken; a chord that is slightly early alongside a
   *   sweep that is equally early does not.
   *
   * @param {Array<{t:number,label:string}>} chords  time-sorted
   * @param {{time:number,text:string,words?:Array<{time:number}>}} line
   * @param {object|null} nextLine  bounds this line; null for the last one
   * @returns {Map<number, Array<object>>} word index -> chords on that word
   */
  function chordsForLine(chords, line, nextLine) {
    const out = new Map();
    if (!chords || !chords.length || !line) return out;

    const start = line.time;
    const end = nextLine ? nextLine.time : start + LAST_LINE_TAIL_SECONDS;
    const inLine = chords.filter((c) => c.t >= start && c.t < end);
    if (!inLine.length) return out;

    const nWords = wordCountOf(line);

    for (const c of inLine) {
      let idx;
      if (line.words && line.words.length) {
        idx = 0;
        for (let i = 0; i < line.words.length; i++) {
          if (line.words[i].time <= c.t) idx = i;
          else break;
        }
      } else {
        const span = Math.max(0.001, end - start);
        idx = Math.floor(((c.t - start) / span) * nWords);
      }
      if (idx < 0) idx = 0;
      if (idx > nWords - 1) idx = nWords - 1;

      // Two chords on one word STACK. They are never bumped to the next word.
      //
      // Bumping looks tidier and is wrong. Displacing one chord frees its slot
      // for the next, which then displaces in turn, so a run of close changes
      // walks steadily away from the words it belongs to — and a chord over the
      // wrong word tells a musician to play the wrong thing at the wrong time.
      // Two symbols sharing a cell is merely cramped, and still says exactly
      // when both changes happen.
      out.set(idx, (out.get(idx) || []).concat(c));
    }
    return out;
  }

  /**
   * Chords with no lyric line to sit on — intros, solos, breakdowns. For a
   * musician these are the parts actually being played, so they are the last
   * thing that should be dropped.
   *
   * @returns {Array<object>} chords falling inside `gap`
   */
  function chordsInGap(chords, gap) {
    if (!chords || !gap) return [];
    return chords.filter((c) => c.t >= gap.start && c.t < gap.end);
  }

  return { chordsForLine, chordsInGap, LAST_LINE_TAIL_SECONDS };
});
