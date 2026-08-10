// The lead sheet: render lyrics, place chords above them, follow playback.
//
// Forked from Karafilt's sidepanel.js:496-1010, which is the mature part of
// that codebase. The structural change is in makeLineEl: every word is wrapped
// in a two-row .wcol (chord above, word below) instead of sitting directly in
// the line.
//
// That wrapper is what makes the whole feature cheap. The chord row is a
// sibling inside the word's own inline box, so querySelectorAll(".word") still
// returns the same spans in the same document order — updateWordHighlight,
// highlightLine, syncToPlaybackTime and the word-sweep CSS all keep working
// verbatim. Nothing below had to learn about chords.
//
// The chord API is present but unfed until chord detection lands; setChords()
// is the entire seam.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltLeadSheet = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LRC = globalThis.InstrufiltLRC;
  const CL = globalThis.InstrufiltChordLayout;
  const LT = globalThis.KarafiltLineTokens;

  // Highlights fire this much ahead of the playback clock. Aligners mark
  // onsets 20-60ms late and the paint lands a frame behind the audio.
  // Playing only — paused scrubbing stays exact.
  const LEAD_SECONDS = 0.05;
  // The last line has no successor to bound it.
  const LAST_LINE_TAIL_SECONDS = 4;
  const SCROLL_MS = 600;

  function create(opts) {
    const sheetEl = opts.sheet;
    const gapEl = opts.gap;
    const gapFillEl = opts.gapFill;
    const gapNumEl = opts.gapNum;
    const gapChordsEl = opts.gapChords || null;
    const statusEl = opts.status;
    // The now/next strip: {strip, chord, next, arrow}. Optional, like the gap
    // elements — the sheet works without it.
    const nowEls = opts.now || null;
    // Fired when the CURRENT chord changes: (now, next, {live}). The panel
    // hangs the fingering diagrams off this.
    const onNowChord = typeof opts.onNowChord === "function" ? opts.onNowChord : null;

    let lines = [];            // [{time, text, words?}]
    let plain = null;          // untimed fallback text
    let chords = [];           // [{t, label, confidence?, live?}] — chord phase
    let activeIndex = -1;
    let gapsCache = { source: null, gaps: [] };
    let emptyText = null;      // survives re-renders; setChords used to wipe it

    let lastTime = 0;
    let lastWall = 0;
    let duration = 0;
    let paused = true;
    let rafId = null;
    let scrollRaf = null;
    let pendingRestore = null;

    // Idempotence indices for the chord-rate surfaces. -2 forces a repaint
    // after a rebuild; -1 is a real state ("before the first chord").
    let nowIndex = -2;
    let gapChipsKey = null;
    let gapChipEls = [];
    let gapChipNowIdx = -2;
    let streamEls = [];
    let streamNowIdx = -2;

    // ── rendering ─────────────────────────────────────────────────────────

    function gaps() {
      if (gapsCache.source !== lines) {
        gapsCache = { source: lines, gaps: LRC.computeGaps(lines) };
      }
      return gapsCache.gaps;
    }

    function makeLineEl(line, index) {
      const div = document.createElement("div");
      div.className = "line";
      div.dir = "auto";        // per-line bidi, so RTL lyrics lay out correctly
      div.dataset.index = String(index);

      // Measured word lists map 1:1 onto spans; unspaced scripts without
      // timing get dictionary segmentation; Latin keeps the whitespace split.
      const tokens = LT.lineTokens(
        line.text || "",
        line.words ? line.words.map((w) => w.text) : null
      );

      // Resolved once per render, not per frame. The placement rules live in
      // shared/chord-layout.js so their edge cases can be asserted rather than
      // eyeballed in a screenshot.
      const chordsByWord = CL.chordsForLine(chords, line, lines[index + 1]);
      let wordIndex = 0;

      for (const tok of tokens) {
        if (!tok.text) continue;
        if (!tok.isWord) {
          // Separators stay bare text nodes so wrapping behaves normally.
          div.appendChild(document.createTextNode(tok.text));
          continue;
        }
        const col = document.createElement("span");
        col.className = "wcol";

        const chord = document.createElement("span");
        chord.className = "chord";
        const placed = chordsByWord.get(wordIndex);
        if (placed) {
          chord.textContent = placed.map((c) => c.label).join(" ");
          if (placed.some((c) => c.live)) chord.classList.add("is-live");
          if (placed.some((c) => c.confidence !== undefined && c.confidence < 0.5)) {
            chord.classList.add("is-low-confidence");
          }
        }
        col.appendChild(chord);

        const span = document.createElement("span");
        span.className = "word upcoming";
        span.textContent = tok.text;
        col.appendChild(span);

        div.appendChild(col);
        wordIndex++;
      }
      return div;
    }

    function render() {
      // During the Listening pass a chord event lands roughly once a second and
      // each one re-renders. Without preserving these, every event would reset
      // the scroll to the top and then animate back down — the sheet would
      // visibly lurch once a second for the whole first play.
      const savedScroll = sheetEl.scrollTop;
      const savedActive = activeIndex;

      sheetEl.innerHTML = "";
      activeIndex = -1;
      sheetEl.classList.toggle("has-chords", chords.length > 0);
      sheetEl.classList.remove("chords-only");
      streamEls = [];
      streamNowIdx = -2;
      invalidateGapChips();
      pendingRestore = { scroll: savedScroll, active: savedActive };

      if (lines.length === 0 && !plain) {
        sheetEl.classList.remove("unsynced");
        // No lyrics is not no content: instrumentals and lyricless charts
        // render the chord stream itself. Before this branch existed, a song
        // with chords but no lyrics showed a blank sheet — setChords() wiped
        // the "no lyrics found" message and then drew nothing.
        if (chords.length > 0) {
          renderChordStream();
          // The listening pass re-renders ~1/sec; without the restore the
          // stream would flash to the top on every chord event, same reason
          // the synced path preserves its scroll.
          if (pendingRestore && pendingRestore.scroll > 0) sheetEl.scrollTop = pendingRestore.scroll;
          pendingRestore = null;
          if (lastTime > 0) syncTo(lastTime);
        } else if (emptyText) {
          const div = document.createElement("div");
          div.className = "sheet-empty";
          div.textContent = emptyText;
          sheetEl.appendChild(div);
        }
        updateNowStrip(currentAdjusted());
        return;
      }

      if (lines.length === 0 && plain) {
        // Untimed: render as prose and scroll linearly. No word state, because
        // there is no timing to base one on.
        sheetEl.classList.add("unsynced");
        for (const text of plain.split(/\r?\n/)) {
          const div = document.createElement("div");
          div.className = "line";
          div.dir = "auto";
          div.textContent = text;
          sheetEl.appendChild(div);
        }
        // Chord events re-render this path too during the listening pass;
        // without the restore the prose jumps to the top once a second.
        if (pendingRestore && pendingRestore.scroll > 0) sheetEl.scrollTop = pendingRestore.scroll;
        pendingRestore = null;
        return;
      }

      sheetEl.classList.remove("unsynced");
      lines.forEach((line, i) => sheetEl.appendChild(makeLineEl(line, i)));

      // Re-apply the previous active line WITHOUT animating, then restore the
      // scroll offset. Only after that does syncTo run, so it sees the line as
      // already current and its idempotence guard suppresses a scroll.
      if (pendingRestore && pendingRestore.active >= 0 && pendingRestore.active < lines.length) {
        const el = sheetEl.querySelector(`.line[data-index="${pendingRestore.active}"]`);
        if (el) {
          el.classList.add("active");
          activeIndex = pendingRestore.active;
        }
      }
      if (pendingRestore && pendingRestore.scroll > 0) sheetEl.scrollTop = pendingRestore.scroll;
      pendingRestore = null;

      // Apply the current position immediately, so switching songs or
      // re-rendering mid-playback doesn't flash an unhighlighted sheet.
      if (lastTime > 0) syncTo(lastTime);
      else updateNowStrip(0);
    }

    // What syncTo would call "now" — for surfaces refreshed outside the tick.
    function currentAdjusted() {
      return paused || lastTime === 0 ? lastTime : lastTime + LEAD_SECONDS;
    }

    // ── scrolling ─────────────────────────────────────────────────────────

    // Custom easing rather than CSS scroll-behavior: a CSS smooth scroll
    // cannot be retargeted mid-flight, so fast line changes fight each other.
    function smoothScrollTo(targetTop) {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      const startTop = sheetEl.scrollTop;
      const distance = targetTop - startTop;
      if (Math.abs(distance) < 1) { sheetEl.scrollTop = targetTop; return; }
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / SCROLL_MS);
        sheetEl.scrollTop = startTop + distance * ease(t);
        scrollRaf = t < 1 ? requestAnimationFrame(step) : null;
      };
      scrollRaf = requestAnimationFrame(step);
    }

    function highlightLine(index) {
      if (index === activeIndex) return;      // idempotent: called every tick
      const prev = sheetEl.querySelector(".line.active");
      if (prev) prev.classList.remove("active");
      const next = sheetEl.querySelector(`.line[data-index="${index}"]`);
      if (next) {
        next.classList.add("active");
        smoothScrollTo(next.offsetTop + next.offsetHeight / 2 - sheetEl.clientHeight / 2);
      }
      activeIndex = index;
    }

    // ── word sweep ────────────────────────────────────────────────────────

    function setWordProgress(el, cls, start, end, t) {
      if (cls === "word singing") {
        const pct = end > start ? Math.min(100, Math.max(0, (100 * (t - start)) / (end - start))) : 100;
        el.style.setProperty("--word-progress", pct.toFixed(1) + "%");
      } else if (el.style.getPropertyValue("--word-progress")) {
        // Cleared on exit so seeking back into a line starts the sweep fresh.
        el.style.removeProperty("--word-progress");
      }
    }

    function updateWordHighlight(t) {
      if (activeIndex < 0 || activeIndex >= lines.length) return;
      const lineEl = sheetEl.querySelector(".line.active");
      if (!lineEl) return;
      const words = lineEl.querySelectorAll(".word");
      if (words.length === 0) return;

      const line = lines[activeIndex];
      const start = line.time;
      const next = lines[activeIndex + 1];
      const end = next ? next.time : start + LAST_LINE_TAIL_SECONDS;

      // Measured timing, when the parsed word list matches the rendered spans.
      if (line.words && line.words.length === words.length) {
        for (let i = 0; i < words.length; i++) {
          const ws = line.words[i].time;
          const we = i + 1 < line.words.length ? line.words[i + 1].time : end;
          const cls = t >= we ? "word sung" : t >= ws ? "word singing" : "word upcoming";
          if (words[i].className !== cls) words[i].className = cls;
          setWordProgress(words[i], cls, ws, we, t);
        }
        return;
      }

      // Estimated: each word takes an equal 1/N slice of the line.
      const span = Math.max(0.001, end - start);
      const progress = Math.max(0, Math.min(1, (t - start) / span));
      const sungBefore = Math.min(words.length, Math.floor(progress * words.length));
      for (let i = 0; i < words.length; i++) {
        const cls = progress >= 1 || i < sungBefore ? "word sung"
          : i === sungBefore ? "word singing"
          : "word upcoming";
        if (words[i].className !== cls) words[i].className = cls;
        setWordProgress(words[i], cls, i / words.length, (i + 1) / words.length, progress);
      }
    }

    // ── chord-rate surfaces: now/next strip, gap chips, chord stream ──────
    //
    // All three follow the sheet's own pattern: a stateless index search per
    // update, an idempotence guard, and DOM writes only on change — so the
    // rAF loop pays an integer compare per frame, not a re-render.

    /** Index of the last chord at or before t, or -1. Mirror of lineIndexAt. */
    function chordIndexAt(t) {
      let lo = 0, hi = chords.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (chords[mid].t <= t) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return found;
    }

    function fireNowChord(now, next, live) {
      if (onNowChord) { try { onNowChord(now, next, { live: !!live }); } catch {} }
    }

    function updateNowStrip(t) {
      if (!nowEls) return;
      if (!chords.length) {
        if (!nowEls.strip.hidden) {
          nowEls.strip.hidden = true;
          fireNowChord(null, null, false);
        }
        nowIndex = -2;
        return;
      }
      const idx = chordIndexAt(t);
      if (idx === nowIndex && !nowEls.strip.hidden) return;
      nowIndex = idx;
      nowEls.strip.hidden = false;

      const now = idx >= 0 ? chords[idx] : null;
      const isLive = !!(now && now.live);
      // The listening pass is causal: it cannot know the future, so during it
      // the strip shows no "next" — the same honesty rule as .is-live styling.
      const next = !isLive && idx + 1 < chords.length ? chords[idx + 1] : null;

      nowEls.chord.textContent = now ? now.label : "—";
      // Long labels ("F#m7b5", "Eb/Ab") step down a size so now+next still
      // fit a 320px panel.
      nowEls.chord.classList.toggle("long", !!(now && now.label.length > 4));
      nowEls.chord.classList.toggle("is-live", isLive);
      if (nowEls.next) nowEls.next.textContent = next ? next.label : "";
      if (nowEls.arrow) nowEls.arrow.style.visibility = next ? "" : "hidden";
      fireNowChord(now, next, isLive);
    }

    // Chips for the chords of ONE gap, living inside the count-in card. Built
    // once on gap entry, class-swept per chord change.
    function invalidateGapChips() {
      gapChipsKey = null;
      gapChipNowIdx = -2;
      gapChipEls = [];
      if (gapChordsEl) { gapChordsEl.textContent = ""; gapChordsEl.hidden = true; }
      if (gapEl) gapEl.classList.remove("has-chords");
    }

    function updateGapChips(gap, t) {
      if (!gapChordsEl) return;
      if (!gap || !chords.length) {
        if (gapChipsKey !== null) invalidateGapChips();
        return;
      }
      const key = gap.start + ":" + gap.end;
      if (gapChipsKey !== key) {
        gapChipsKey = key;
        gapChipNowIdx = -2;
        gapChipEls = [];
        gapChordsEl.textContent = "";
        const inGap = CL.chordsInGap(chords, gap);
        if (!inGap.length) {
          gapChordsEl.hidden = true;
          gapEl.classList.remove("has-chords");
          return;
        }
        for (const c of inGap) {
          const el = document.createElement("span");
          el.className = "gap-chip";
          el.textContent = c.label;
          if (c.live) el.classList.add("is-live");
          gapChordsEl.appendChild(el);
          gapChipEls.push({ t: c.t, el });
        }
        gapChordsEl.hidden = false;
        gapEl.classList.add("has-chords");
      }
      if (!gapChipEls.length) return;
      let idx = -1;
      for (let i = 0; i < gapChipEls.length; i++) {
        if (gapChipEls[i].t <= t) idx = i;
        else break;
      }
      if (idx === gapChipNowIdx) return;
      gapChipNowIdx = idx;
      gapChipEls.forEach((c, i) => {
        c.el.classList.toggle("is-past", i < idx);
        c.el.classList.toggle("is-now", i === idx);
      });
    }

    // The chords-only chart: the whole song as a wrapping chip stream. This is
    // the instrumentals path — exactly where a musician most needs the chords
    // and where there are no lyrics to hang them on.
    function renderChordStream() {
      sheetEl.classList.add("chords-only");
      const wrap = document.createElement("div");
      wrap.className = "chord-stream";
      streamEls = [];
      streamNowIdx = -2;
      for (const c of chords) {
        const el = document.createElement("span");
        el.className = "gap-chip stream-chip";
        el.textContent = c.label;
        if (c.live) el.classList.add("is-live");
        wrap.appendChild(el);
        streamEls.push({ t: c.t, el });
      }
      sheetEl.appendChild(wrap);
    }

    function updateChordStream(t) {
      if (!streamEls.length) return;
      let lo = 0, hi = streamEls.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (streamEls[mid].t <= t) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (idx === streamNowIdx) return;
      const wasRebuild = streamNowIdx === -2;
      streamNowIdx = idx;
      streamEls.forEach((c, i) => {
        c.el.classList.toggle("is-past", i < idx);
        c.el.classList.toggle("is-now", i === idx);
      });
      if (idx >= 0) {
        const el = streamEls[idx].el;
        const target = el.offsetTop + el.offsetHeight / 2 - sheetEl.clientHeight / 2;
        if (wasRebuild) {
          // First position after a re-render: snap, don't animate. The
          // listening pass rebuilds ~1/sec, and a 600ms glide from wherever
          // the restore left us reads as a lurch, not a follow.
          if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
          sheetEl.scrollTop = target;
        } else {
          smoothScrollTo(target);
        }
      }
    }

    // ── instrumental count-in ─────────────────────────────────────────────

    /** In a gap's final second the upcoming line takes the stage early. */
    function stagedLineIndex(t) {
      for (const g of gaps()) if (t >= g.end - 1 && t < g.end) return g.nextIndex;
      return -1;
    }

    // Every value is written per update; CSS transitions would retarget each
    // frame and stutter.
    function updateGapBar(t) {
      if (!gapEl || !gapFillEl) return false;
      let gap = null;
      for (const g of gaps()) if (t >= g.start && t < g.end - 1) { gap = g; break; }
      updateGapChips(gap, t);
      if (!gap) {
        gapEl.style.opacity = "0";
        sheetEl.style.opacity = "";
        return false;
      }
      const entry = Math.min(1, (t - gap.start) / 0.45);
      const linear = Math.min(1, Math.max(0, (gap.end - t - 1) / 1));
      const exit = linear * linear * (3 - 2 * linear);      // smoothstep
      const opacity = Math.min(entry, exit);
      gapFillEl.style.width = `${Math.min(1, Math.max(0, (t - gap.start) / (gap.end - gap.start))) * 100}%`;
      if (gapNumEl) gapNumEl.textContent = String(Math.max(1, Math.ceil(gap.end - t)));
      gapEl.style.opacity = String(opacity);
      sheetEl.style.opacity = String(1 - 0.78 * opacity);
      return true;
    }

    // ── the sync loop ─────────────────────────────────────────────────────

    function syncTo(t) {
      const adjusted = paused ? t : t + LEAD_SECONDS;
      updateGapBar(adjusted);
      updateNowStrip(adjusted);
      updateChordStream(adjusted);

      if (lines.length === 0) {
        // Untimed lyrics: linear scroll. Drifts across long intros, but at
        // least it moves in the right direction.
        if (plain && duration > 0) {
          const max = sheetEl.scrollHeight - sheetEl.clientHeight;
          if (max > 0) sheetEl.scrollTop = Math.min(1, Math.max(0, t / duration)) * max;
        }
        return;
      }

      // Stateless binary search over absolute time — this is what makes
      // seeking free. There is no cursor to invalidate, so a seek self-corrects
      // within one tick and needs no handling anywhere.
      const staged = stagedLineIndex(adjusted);
      const found = staged >= 0 ? staged : LRC.lineIndexAt(lines, adjusted);
      if (found >= 0) {
        highlightLine(found);
        updateWordHighlight(adjusted);
      }
    }

    // Interpolates between the content script's 200ms ticks so the sweep moves
    // smoothly. Self-stopping: no idle rAF burn when nothing is animating.
    function rafTick() {
      rafId = null;
      if (paused) return;
      const t = lastTime + (performance.now() - lastWall) / 1000 + LEAD_SECONDS;
      const inGap = updateGapBar(t);
      updateNowStrip(t);
      updateChordStream(t);
      const line = activeIndex >= 0 && activeIndex < lines.length ? lines[activeIndex] : null;
      if (line) updateWordHighlight(t);
      // With chords on screen the strip/chips must not quantise to the 200ms
      // tick — a chord landing 200ms late is a wrong chord to a musician.
      else if (!inGap && chords.length === 0) return;
      rafId = requestAnimationFrame(rafTick);
    }

    // ── public surface ────────────────────────────────────────────────────

    return {
      /** @param {{syncedLyrics?:string, plainLyrics?:string}|null} result */
      setLyrics(result) {
        if (!result || !result.found) { lines = []; plain = null; }
        else {
          lines = result.syncedLyrics ? LRC.parseLRC(result.syncedLyrics) : [];
          plain = lines.length === 0 ? (result.plainLyrics || null) : null;
          emptyText = null;      // real content has arrived
        }
        render();
      },

      /** The chord-detection seam. @param {Array<{t,label,confidence?,live?}>} next */
      setChords(next) {
        chords = Array.isArray(next) ? next.slice().sort((a, b) => a.t - b.t) : [];
        nowIndex = -2;           // labels may have changed (transpose) at the same index
        render();
      },

      onPlayback({ time, duration: dur, paused: isPaused }) {
        lastTime = time;
        lastWall = performance.now();
        paused = !!isPaused;
        if (typeof dur === "number") duration = dur;
        syncTo(time);
        if (!paused && rafId === null) rafId = requestAnimationFrame(rafTick);
      },

      setStatus(text) {
        if (statusEl) statusEl.textContent = text || "";
      },

      // Stores the text rather than painting it directly: chords can arrive
      // AFTER this call, and their re-render used to wipe the message and draw
      // nothing. render() owns the precedence now — content beats message.
      showEmpty(text) {
        emptyText = text || "";
        render();
      },

      reset() {
        lines = [];
        plain = null;
        chords = [];
        activeIndex = -1;
        pendingRestore = null;
        emptyText = null;
        lastTime = 0;
        duration = 0;
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        // An in-flight scroll glide keeps writing scrollTop values computed
        // from the OLD song's geometry; the next song's sheet must not
        // inherit them.
        if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
        if (gapEl) gapEl.style.opacity = "0";
        sheetEl.style.opacity = "";
        render();
      },

      hasLyrics: () => lines.length > 0 || !!plain,
      isSynced: () => lines.length > 0,
    };
  }

  return { create, LEAD_SECONDS, LAST_LINE_TAIL_SECONDS };
});
