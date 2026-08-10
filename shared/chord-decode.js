// Offline chord decoding: Viterbi over the buffered chroma.
//
// The C decoder is causal — it must be, it runs on the audio thread — so it
// commits to a chord after a hold window and can never revise. This one sees
// the whole song and can, which is worth a lot: most causal errors are single
// frames of a neighbouring chord in the middle of an otherwise stable segment,
// and a transition prior removes them almost entirely.
//
// Deliberately JS and not more C. The audio thread stays cheap, and the part of
// the system most likely to need iteration lives somewhere it can be changed
// without emscripten in the loop.
//
// 25 states (12 major + 12 minor + N) over a few thousand frames is ~150k
// operations — a few milliseconds, once per song.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltChordDecode = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const N_PC = 12;
  const N_STATES = 25;          // 0-11 major, 12-23 minor, 24 = N
  const NONE = 24;

  const TPL_MAJ = [1,0,0,0,1,0,0,1,0,0,0,0];
  const TPL_MIN = [1,0,0,1,0,0,0,1,0,0,0,0];
  const INV_SQRT3 = 0.5773503;

  // Mean chord length ~1.4 s at 23.4 fps. High self-transition is the whole
  // point: it is what turns a jittery frame-by-frame argmax into segments.
  const P_SELF = 0.97;
  const MIN_FIT = 0.58;         // matches CH_MIN_FIT in chroma.c

  // Scores are similarities, not log-probabilities. Scaling makes the gap
  // between a good and a bad fit commensurate with the transition penalty;
  // without it the prior dominates completely and the decode returns a single
  // chord for the whole song.
  const EMIT_SCALE = 12;

  // How far N outscores every triad on a frame that fits nothing.
  //
  // Sized against the transition cost, not picked by eye. Entering and leaving
  // N costs 2*(log(pSelf) - log((1-pSelf)/24)) ~ 13.3 nats, so a run of k
  // non-harmonic frames only becomes N when k * MARGIN * EMIT_SCALE exceeds
  // that — i.e. k > ~7 frames, about 0.3 s. A single odd frame stays inside the
  // surrounding chord, which is what we want; a real break becomes a break.
  //
  // At the +0.01 this started as, N was mathematically unreachable: silence
  // decoded as whatever chord happened to precede it, and the chart claimed a
  // chord was ringing through an empty bar.
  const N_MARGIN = 0.15;

  /**
   * Per-frame log-likelihood for each of the 25 states.
   * Mirrors match_chord() in chroma.c so the two decoders agree about what the
   * features mean and differ only in how they decode them.
   */
  function frameScores(chroma, bass) {
    const s = new Float64Array(N_STATES);
    let bestFit = 0;
    let bestScore = -Infinity;

    for (let q = 0; q < 2; q++) {
      const tpl = q ? TPL_MIN : TPL_MAJ;
      const third = q ? 3 : 4;
      for (let r = 0; r < N_PC; r++) {
        let dot = 0;
        for (let i = 0; i < N_PC; i++) dot += chroma[(r + i) % N_PC] * tpl[i];
        dot *= INV_SQRT3;
        const bb = bass
          ? 0.22 * bass[r] + 0.08 * (bass[(r + third) % N_PC] + bass[(r + 7) % N_PC])
          : 0;
        const score = dot + bb;
        s[q * 12 + r] = score;
        if (dot > bestFit) bestFit = dot;
        if (score > bestScore) bestScore = score;
      }
    }

    // N's emission is gated on FIT alone, never on fit-plus-bass — the same
    // split match_chord() makes in chroma.c, and for the same reason. Bass
    // evidence lifts every candidate together, so including it here let flat
    // chroma (white noise, an inharmonic wash) clear the gate: a triad scores
    // exactly 0.5 on flat chroma, under the 0.58 threshold, but the bass bonus
    // added ~0.11 and the decoder confidently named C major in static.
    s[NONE] = bestFit < MIN_FIT
      ? bestScore + N_MARGIN      // nothing looks like a triad — N must win
      : MIN_FIT - 0.005;          // a real triad is present — N competes and loses
    return s;
  }

  /**
   * Viterbi over frames.
   *
   * @param {Array<{chroma:Float32Array|number[], bass?:Float32Array|number[], t:number}>} frames
   * @param {{pSelf?:number}} [opts]
   * @returns {number[]} one state index per frame
   */
  function viterbi(frames, opts) {
    const n = frames.length;
    if (n === 0) return [];

    const pSelf = (opts && opts.pSelf) || P_SELF;
    // Uniform over the 24 alternatives. A key-aware prior would be better and
    // is a genuine future improvement; it needs a key estimate, which needs a
    // decode, so v1 keeps it uniform rather than bootstrapping.
    const stay = Math.log(pSelf);
    const move = Math.log((1 - pSelf) / (N_STATES - 1));

    let prev = new Float64Array(N_STATES);
    const back = new Uint8Array(n * N_STATES);

    let sc = frameScores(frames[0].chroma, frames[0].bass);
    for (let s = 0; s < N_STATES; s++) prev[s] = EMIT_SCALE * sc[s];

    for (let i = 1; i < n; i++) {
      sc = frameScores(frames[i].chroma, frames[i].bass);
      const cur = new Float64Array(N_STATES);

      // The transition matrix has only two distinct values, so the best
      // predecessor is either "stay in s" or "come from the global best".
      // That collapses the inner loop from O(states^2) to O(states).
      let bestPrev = -Infinity, bestPrevIdx = 0;
      for (let s = 0; s < N_STATES; s++) {
        if (prev[s] > bestPrev) { bestPrev = prev[s]; bestPrevIdx = s; }
      }

      for (let s = 0; s < N_STATES; s++) {
        const fromSelf = prev[s] + stay;
        const fromOther = (bestPrevIdx === s)
          ? secondBest(prev, s) + move
          : bestPrev + move;
        if (fromSelf >= fromOther) {
          cur[s] = fromSelf + EMIT_SCALE * sc[s];
          back[i * N_STATES + s] = s;
        } else {
          cur[s] = fromOther + EMIT_SCALE * sc[s];
          back[i * N_STATES + s] = (bestPrevIdx === s) ? secondBestIdx(prev, s) : bestPrevIdx;
        }
      }
      prev = cur;
    }

    let bestIdx = 0;
    for (let s = 1; s < N_STATES; s++) if (prev[s] > prev[bestIdx]) bestIdx = s;

    const path = new Array(n);
    path[n - 1] = bestIdx;
    for (let i = n - 1; i > 0; i--) path[i - 1] = back[i * N_STATES + path[i]];
    return path;
  }

  function secondBest(arr, skip) {
    let best = -Infinity;
    for (let i = 0; i < arr.length; i++) if (i !== skip && arr[i] > best) best = arr[i];
    return best;
  }
  function secondBestIdx(arr, skip) {
    let best = -Infinity, idx = 0;
    for (let i = 0; i < arr.length; i++) if (i !== skip && arr[i] > best) { best = arr[i]; idx = i; }
    return idx;
  }

  /** Greedy per-frame argmax. Only used as the baseline Viterbi must beat. */
  function greedy(frames) {
    return frames.map((f) => {
      const s = frameScores(f.chroma, f.bass);
      let best = 0;
      for (let i = 1; i < N_STATES; i++) if (s[i] > s[best]) best = i;
      return best;
    });
  }

  /**
   * Collapse a per-frame state path into timed segments.
   * @returns {Array<{t:number, endT:number, root:number, quality:number, confidence:number}>}
   */
  function toSegments(path, frames, opts) {
    const minDur = (opts && opts.minDurationSec) || 0.4;
    const segs = [];
    if (!path.length) return segs;

    let start = 0;
    for (let i = 1; i <= path.length; i++) {
      if (i < path.length && path[i] === path[start]) continue;

      const state = path[start];
      const t = frames[start].t;
      const endT = i < frames.length ? frames[i].t
        : frames[frames.length - 1].t + (frames.length > 1
            ? frames[frames.length - 1].t - frames[frames.length - 2].t
            : 0.5);

      if (state !== NONE) {
        // Mean margin across the segment, as a confidence proxy.
        let conf = 0;
        for (let j = start; j < i; j++) {
          const sc = frameScores(frames[j].chroma, frames[j].bass);
          let best = -Infinity, second = -Infinity;
          for (let s = 0; s < N_STATES; s++) {
            if (sc[s] > best) { second = best; best = sc[s]; }
            else if (sc[s] > second) second = sc[s];
          }
          const margin = best - second;
          conf += margin / (margin + 0.06);
        }
        conf /= (i - start);

        segs.push({
          t, endT,
          root: state % 12,
          quality: state < 12 ? 0 : 1,
          confidence: conf,
        });
      }
      start = i;
    }

    // Drop segments too short to be played, then re-join neighbours the removal
    // left identical AND adjacent.
    //
    // Adjacency is the important half. Merging on label alone would splice the
    // same chord across a silence or a drum break — telling a musician to hold
    // it through a gap where nothing is being played. A run of N is exactly
    // that kind of break, and it must survive as one. The threshold is minDur:
    // a gap too short to be its own segment is too short to be a real break.
    const kept = segs.filter((s) => s.endT - s.t >= minDur);
    const merged = [];
    for (const s of kept) {
      const last = merged[merged.length - 1];
      const sameChord = last && last.root === s.root && last.quality === s.quality;
      const adjacent = last && s.t - last.endT <= minDur;
      if (sameChord && adjacent) last.endT = s.endT;
      else merged.push({ ...s });
    }
    return merged;
  }

  /**
   * Full offline pass: frames in, timed chord segments out.
   */
  function decode(frames, opts) {
    if (!frames || frames.length === 0) return [];
    return toSegments(viterbi(frames, opts), frames, opts);
  }

  /**
   * Aggregate chroma over a whole song, for key estimation.
   * @returns {number[]} 12 pitch-class weights, L2-normalised
   */
  function aggregateChroma(frames) {
    const agg = new Array(12).fill(0);
    for (const f of frames) {
      for (let i = 0; i < 12; i++) agg[i] += f.chroma[i];
    }
    let s = 0;
    for (const v of agg) s += v * v;
    if (s > 1e-12) {
      const inv = 1 / Math.sqrt(s);
      for (let i = 0; i < 12; i++) agg[i] *= inv;
    }
    return agg;
  }

  return {
    decode, viterbi, greedy, toSegments, frameScores, aggregateChroma,
    N_STATES, NONE, P_SELF,
  };
});
