// Instrufilt side panel.
//
// The panel owns no state of its own — the service worker does, because
// isolation keeps running while the panel is closed and the SW gets evicted
// while it runs. Every control writes through SET_SETTING and every render
// comes from GET_STATE or a CAPTURE_STATE broadcast.

(() => {
  "use strict";

  const els = {
    mark: document.getElementById("mark"),
    statusBadge: document.getElementById("status-badge"),
    statusText: document.getElementById("status-text"),
    nowPlaying: document.getElementById("now-playing"),
    toggleBtn: document.getElementById("toggle-btn"),
    toggleLabel: document.getElementById("toggle-label"),
    hint: document.getElementById("hint"),
    modeSelect: document.getElementById("mode-select"),
    modeHint: document.getElementById("mode-hint"),
    amountSlider: document.getElementById("amount-slider"),
    amountValue: document.getElementById("amount-value"),
    makeupSlider: document.getElementById("makeup-slider"),
    makeupValue: document.getElementById("makeup-value"),
    autoGain: document.getElementById("autogain-toggle"),
    mono: document.getElementById("mono-toggle"),
    latencyNote: document.getElementById("latency-note"),
    refreshBtn: document.getElementById("refresh-lyrics"),
    chordBar: document.getElementById("chord-bar"),
    chordTierText: document.getElementById("chord-tier-text"),
    chordKey: document.getElementById("chord-key"),
    chordProgress: document.getElementById("chord-progress"),
    chordProgressFill: document.getElementById("chord-progress-fill"),
    transposeVal: document.getElementById("transpose-val"),
    transposeUp: document.getElementById("transpose-up"),
    transposeDown: document.getElementById("transpose-down"),
    reanalyze: document.getElementById("reanalyze"),
    chordsToggle: document.getElementById("chords-toggle"),
    onlineChordsToggle: document.getElementById("online-chords-toggle"),
    howtoBtn: document.getElementById("howto-btn"),
    songsterrBtn: document.getElementById("songsterr-btn"),
    nowChord: document.getElementById("now-chord"),
    diagramTray: document.getElementById("diagram-tray"),
    diagramNow: document.getElementById("diagram-now"),
    diagramNext: document.getElementById("diagram-next"),
    diagramNowLabel: document.getElementById("diagram-now-label"),
    diagramNextLabel: document.getElementById("diagram-next-label"),
  };

  const sheet = InstrufiltLeadSheet.create({
    sheet: document.getElementById("sheet"),
    gap: document.getElementById("sheet-gap"),
    gapFill: document.getElementById("sheet-gap-fill"),
    gapNum: document.getElementById("sheet-gap-num"),
    gapChords: document.getElementById("sheet-gap-chords"),
    status: document.getElementById("sheet-status"),
    now: {
      strip: document.getElementById("now-strip"),
      chord: document.getElementById("now-chord"),
      next: document.getElementById("next-chord"),
      arrow: document.getElementById("now-arrow"),
    },
    onNowChord: handleNowChord,
  });

  // Written for a musician, not a DSP engineer: what it does to the sound, and
  // what it costs, in that order.
  const MODE_HINTS = {
    vocal_rhythm:
      "Singer plus centred kick, bass and snare. Keeps a groove to lock to — the best starting point.",
    vocal_only:
      "Singer alone, filtered clear of the rhythm section. Cleanest reference, but no time feel.",
    lead_line:
      "A narrow band around the voice, for picking a melody out by ear. Thin on purpose.",
  };

  let isActive = false;
  let pinnedTabId = null;
  let hasMedia = false;
  let currentVideoKey = null;
  let currentSong = { artist: null, track: null };
  let instrument = "guitar";

  // Chord state. Raw {t, root, quality, confidence} — labels are derived on
  // render so transposing is a relabel, never a re-analysis. `source` is
  // provenance ("local" | "songle"): the tier pill text and the attribution
  // Songle's terms require both hang off it.
  let chordState = { tier: null, chords: [], key: null, tuning: 0, coverage: 0, source: null };
  let transpose = 0;

  // The two halves of the sheet-status strip, composed in one place so the
  // lyrics path and the chords path stop overwriting each other's credit.
  // Each half is a list of {text, href?} segments; Karalyr segments link home
  // so the credit states where the data comes from, not just a bare name.
  let lyricsStatus = [];
  let chordsStatus = [];
  function updateSheetStatus() {
    sheet.setStatus([...lyricsStatus, ...chordsStatus]);
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function setMarkState(state) {
    if (els.mark.dataset.state !== state) els.mark.dataset.state = state;
  }

  function renderCaptureState(active, { starting = false, error = null } = {}) {
    isActive = active;

    els.toggleLabel.textContent = active ? "Stop isolating" : "Start isolating";
    els.toggleBtn.classList.toggle("is-active", active);

    els.statusBadge.classList.toggle("is-active", active && !error);
    els.statusBadge.classList.toggle("is-error", !!error);
    els.statusText.textContent = error ? "Error" : starting ? "Starting" : active ? "Isolating" : "Off";

    setMarkState(error ? "idle" : starting ? "starting" : active ? "active" : "idle");

    if (error) {
      els.hint.textContent = error;
    } else if (active) {
      els.hint.textContent = "Isolating this tab. Switching tabs leaves it running here.";
    } else if (!hasMedia) {
      els.hint.textContent = "Play something in this tab, then press Start.";
    } else {
      els.hint.textContent = "Ready when you are.";
    }

    // The isolation slider is meaningless with nothing to isolate.
    els.amountSlider.disabled = !active;
    els.makeupSlider.disabled = !active;
  }

  function renderSettings(s) {
    if (!s) return;
    if (s.mode) {
      els.modeSelect.value = s.mode;
      els.modeHint.textContent = MODE_HINTS[s.mode] || "";
    }
    if (typeof s.amount === "number") {
      els.amountSlider.value = s.amount;
      els.amountValue.textContent = `${s.amount}%`;
    }
    if (typeof s.makeupDb === "number") {
      els.makeupSlider.value = s.makeupDb;
      els.makeupValue.textContent = formatDb(s.makeupDb);
    }
    els.autoGain.checked = !!s.autoGain;
    els.mono.checked = !!s.mono;
    els.chordsToggle.checked = s.chords !== false;
    els.onlineChordsToggle.checked = s.onlineChords !== false;
    if (typeof s.instrument === "string" && s.instrument) instrument = s.instrument;
    els.makeupSlider.disabled = !isActive || !!s.autoGain;
  }

  function formatDb(v) {
    return v > 0 ? `+${v} dB` : `${v} dB`;
  }

  function renderSong(state) {
    hasMedia = !!(state && state.hasMedia);
    const artist = state && state.artist;
    const track = state && state.track;
    const label = artist && track ? `${artist} — ${track}`
      : track ? track
      : state && state.cleanedTitle ? state.cleanedTitle
      : null;

    els.nowPlaying.textContent = label || (hasMedia ? "Playing" : "No media detected");
    els.nowPlaying.classList.toggle("has-song", !!label);
    els.nowPlaying.title = label || "";
    els.refreshBtn.hidden = !hasMedia;

    // The learn buttons need a searchable identity, not just "something is
    // playing" — a raw title works too, but artist+track queries are the ones
    // that actually find tutorials.
    currentSong = { artist: artist || null, track: track || (state && state.cleanedTitle) || null };
    const searchable = !!currentSong.track;
    els.howtoBtn.hidden = !searchable;
    els.songsterrBtn.hidden = !searchable;

    if (!isActive) renderCaptureState(false);

    renderSheet(state);
  }

  function renderSheet(state) {
    const result = state && state.lyrics;

    if (result && result.found) {
      sheet.setLyrics(result);
      // Say where it came from and how good the timing is. A musician needs to
      // know whether the sheet can be trusted to the syllable or only to the
      // line — chord placement is exact in the first case and estimated in the
      // second, and there is no way to tell by looking.
      const timing = result.wordTimed ? "word-synced"
        : result.syncedLyrics ? "line-synced"
        : "no timing";
      lyricsStatus = result.source === "karalyr"
        ? [{ text: "Lyrics: Karalyr", href: "https://www.karalyr.com" }, { text: timing }]
        : [{ text: `Lyrics: LRCLib · ${timing}` }];
      updateSheetStatus();
      return;
    }

    sheet.setLyrics(null);
    lyricsStatus = [];
    updateSheetStatus();
    if (!hasMedia) sheet.showEmpty("No media on this tab");
    else if (state && state.status) sheet.showEmpty(state.status);
    else sheet.showEmpty("No lyrics found for this song");
  }

  // ── chords ────────────────────────────────────────────────────────────────

  function renderChords() {
    const { tier, chords, key, tuning, coverage, source } = chordState;

    els.chordBar.hidden = !tier;
    if (!tier) {
      els.chordProgress.hidden = true;
      chordsStatus = [];
      updateSheetStatus();
      sheet.setChords([]);
      return;
    }

    els.chordBar.dataset.tier = tier;

    // The whole point of the two-tier model, stated plainly. On the first play
    // chords arrive AFTER the beat, which is useless for playing along, so the
    // panel says it is building rather than pretending to lead.
    if (tier === "listening") {
      els.chordTierText.textContent = "Listening — chart ready next play";
      els.chordProgress.hidden = false;
      const pct = Math.min(100, Math.max(0, (chordState.progress || 0) * 100));
      els.chordProgressFill.style.width = `${pct}%`;
    } else {
      const partial = coverage > 0 && coverage < 0.85;
      els.chordTierText.textContent = source === "karalyr" ? "Chart · Karalyr"
        : source === "songle" ? "Chart · Songle"
        : partial ? `Chart (partial — ${Math.round(coverage * 100)}%)`
        : "Chart";
      els.chordProgress.hidden = true;
    }

    // Songle's terms require the credit to be VISIBLE whenever their data is
    // on screen; the status strip is the one line that stays on screen as long
    // as the sheet does. Karalyr is the family's own data — credited for
    // transparency, not obligation.
    chordsStatus = source === "songle" ? [{ text: "Chords: Songle (AIST)" }]
      : source === "karalyr" ? [{ text: "Chords: Karalyr", href: "https://www.karalyr.com" }]
      : [];
    updateSheetStatus();

    const shownKey = key ? InstrufiltChordFormat.transposeKey(key, transpose) : null;
    const bits = [];
    if (shownKey) bits.push(InstrufiltChordFormat.keyName(shownKey));
    // Only surface tuning when it is far enough off to matter — otherwise it is
    // noise the user cannot act on.
    if (Math.abs(tuning) > 0.12) bits.push(`${(tuning * 100).toFixed(0)}¢`);
    els.chordKey.textContent = bits.join(" · ");

    els.transposeVal.textContent = transpose > 0 ? `+${transpose}` : String(transpose);

    const labelled = InstrufiltChordFormat.labelChart(chords, { key, transpose });
    sheet.setChords(labelled.map((c) => ({
      t: c.t,
      label: c.label,
      confidence: c.confidence,
      // During the listening pass, chords seeded from a cached partial chart
      // arrive with live:false and stay authoritative; only the causally
      // detected ones are drawn as provisional.
      live: tier === "listening" && c.live !== false,
      // The fingering diagrams need the transposed chord itself, not just its
      // name — kept on the object so the tray never re-derives pitch from text.
      root: c.root,
      quality: c.quality,
      ext: c.ext,
      bass: c.bass,
    })));
  }

  function setChordState(next) {
    chordState = { ...chordState, ...next };
    renderChords();
  }

  function clearChords() {
    chordState = { tier: null, chords: [], key: null, tuning: 0, coverage: 0, source: null };
    transpose = 0;
    renderChords();
  }

  // Ask the SW for a stored or Songle chart. This is what makes chords appear
  // WITHOUT pressing Start: the offscreen document only exists during capture,
  // but the SW resolver is always there. While capture runs the offscreen
  // broadcast is authoritative, so this only fills the idle case.
  async function requestChart() {
    if (!currentVideoKey) return;
    const requestedKey = currentVideoKey;
    const res = await sendMessage({ type: "FETCH_CHART", videoKey: requestedKey });
    if (!res || !res.found || res.videoKey !== currentVideoKey) return;
    // A live listening pass (or an already-rendered chart) outranks this
    // late-arriving answer.
    if (chordState.tier) return;
    setChordState({
      tier: res.tier,
      chords: res.chords || [],
      key: res.key || null,
      tuning: res.tuning || 0,
      coverage: res.coverage || 0,
      source: res.source || "local",
    });
  }

  // ── learn buttons and fingering tray ──────────────────────────────────────

  function openTab(url) {
    try { chrome.tabs.create({ url }); } catch {}
  }

  els.howtoBtn.addEventListener("click", () => {
    if (!currentSong.track) return;
    const q = ["how to play", currentSong.track, currentSong.artist || "", instrument, "tutorial"]
      .filter(Boolean).join(" ");
    openTab("https://www.youtube.com/results?search_query=" + encodeURIComponent(q));
  });

  els.songsterrBtn.addEventListener("click", () => {
    if (!currentSong.track) return;
    const q = [currentSong.artist || "", currentSong.track].filter(Boolean).join(" ");
    openTab("https://www.songsterr.com/?pattern=" + encodeURIComponent(q));
  });

  let trayOpen = false;
  let trayNow = null;
  let trayNext = null;

  function renderDiagram(svg, labelEl, chord) {
    const CSH = globalThis.InstrufiltChordShapes;
    if (!chord) {
      if (svg) svg.textContent = "";
      if (labelEl) labelEl.textContent = "";
      return;
    }
    labelEl.textContent = chord.label || "";
    const shape = CSH ? CSH.shapeFor(chord) : null;
    if (CSH) CSH.renderInto(svg, shape);
  }

  function renderTray() {
    els.diagramTray.hidden = !trayOpen || (!trayNow && !trayNext);
    if (els.diagramTray.hidden) return;
    renderDiagram(els.diagramNow, els.diagramNowLabel, trayNow);
    renderDiagram(els.diagramNext, els.diagramNextLabel, trayNext);
  }

  function handleNowChord(now, next) {
    trayNow = now;
    trayNext = next;
    if (trayOpen) renderTray();
  }

  els.nowChord.addEventListener("click", () => {
    trayOpen = !trayOpen;
    renderTray();
    try { chrome.storage.local.set({ ifDiagramTray: trayOpen }); } catch {}
  });

  // ── wiring ────────────────────────────────────────────────────────────────

  function setSetting(key, value) {
    chrome.runtime.sendMessage({ type: "SET_SETTING", key, value }).catch(() => {});
  }

  els.toggleBtn.addEventListener("click", async () => {
    if (isActive) {
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE_REQUEST" }).catch(() => {});
      renderCaptureState(false);
      return;
    }

    const tabId = pinnedTabId != null ? pinnedTabId : await activeTabId();
    if (tabId == null) {
      renderCaptureState(false, { error: "No eligible tab. Open a page that plays audio." });
      return;
    }

    renderCaptureState(false, { starting: true });
    els.toggleBtn.disabled = true;

    // Delegated to the SW rather than calling tabCapture here: the activeTab
    // grant a side-panel click carries does not survive into this context on
    // every browser, and the SW's own path is the one that works.
    let res = await sendMessage({ type: "START_CAPTURE", tabId });
    if (!res || !res.success) {
      // Brave and Edge reject getMediaStreamId from a panel gesture; the
      // picker-based path works everywhere.
      res = await sendMessage({ type: "START_CAPTURE_DISPLAY_MEDIA", tabId });
    }

    els.toggleBtn.disabled = false;
    if (!res || !res.success) {
      renderCaptureState(false, { error: "Couldn't capture this tab. Try the Alt+Shift+I shortcut." });
    }
    // Success is confirmed by the CAPTURE_ACTIVE broadcast, not here — the
    // audio graph is not actually running until the worklet reports ready.
  });

  els.modeSelect.addEventListener("change", () => {
    const mode = els.modeSelect.value;
    els.modeHint.textContent = MODE_HINTS[mode] || "";
    setSetting("mode", mode);
  });

  els.amountSlider.addEventListener("input", () => {
    const v = parseInt(els.amountSlider.value, 10);
    els.amountValue.textContent = `${v}%`;
    setSetting("amount", v);
  });

  els.makeupSlider.addEventListener("input", () => {
    const v = parseInt(els.makeupSlider.value, 10);
    els.makeupValue.textContent = formatDb(v);
    setSetting("makeupDb", v);
  });

  els.autoGain.addEventListener("change", () => {
    setSetting("autoGain", els.autoGain.checked);
    els.makeupSlider.disabled = !isActive || els.autoGain.checked;
  });

  els.mono.addEventListener("change", () => setSetting("mono", els.mono.checked));

  // Transpose is display-only — nothing about the audio changes. This is what a
  // capo'd guitarist reads, and it must never trigger a re-analysis.
  function bumpTranspose(delta) {
    transpose = Math.max(-11, Math.min(11, transpose + delta));
    renderChords();
  }
  els.transposeUp.addEventListener("click", () => bumpTranspose(1));
  els.transposeDown.addEventListener("click", () => bumpTranspose(-1));

  els.reanalyze.addEventListener("click", () => {
    // Without capture there is nothing to listen with — discarding the chart
    // would just leave the panel stuck on "Listening" forever.
    if (!isActive) return;
    // videoKey rides along so the SW can invalidate its chart cache for this
    // song; the offscreen document keys off its own currentVideoKey.
    chrome.runtime.sendMessage({ type: "REANALYZE", videoKey: currentVideoKey }).catch(() => {});
    setChordState({ tier: "listening", chords: [], source: "local", progress: 0 });
  });

  els.chordsToggle.addEventListener("change", () => {
    const on = els.chordsToggle.checked;
    chrome.runtime.sendMessage({ type: "SET_CHORDS_ENABLED", value: on }).catch(() => {});
    setSetting("chords", on);
    if (!on) clearChords();
  });

  els.onlineChordsToggle.addEventListener("change", () => {
    // Applies from the next song — the SW consults it inside FETCH_CHART, so
    // no message to the offscreen document is needed (or wanted; the chords
    // toggle's double write path is one too many already).
    setSetting("onlineChords", els.onlineChordsToggle.checked);
  });

  els.refreshBtn.addEventListener("click", async () => {
    const tabId = pinnedTabId != null ? pinnedTabId : await activeTabId();
    if (tabId == null) return;
    els.refreshBtn.classList.add("spinning");
    sheet.showEmpty("Looking for lyrics…");
    chrome.tabs.sendMessage(tabId, { type: "REFRESH_LYRICS" }, () => {
      void chrome.runtime.lastError;   // no content script on this page
    });
    // The result arrives as MEDIA_STATE; this only stops the spinner.
    setTimeout(() => els.refreshBtn.classList.remove("spinning"), 1200);
  });

  // ── messages ──────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender) => {
    // Content scripts broadcast to every extension page, so a second tab
    // playing audio would otherwise drive this panel's sheet. The panel is
    // pinned to one tab; anything from another is not ours.
    if (sender && sender.tab && pinnedTabId != null && sender.tab.id !== pinnedTabId) return;

    switch (message.type) {
      case "CAPTURE_STATE":
        renderCaptureState(!!message.isActive);
        renderSettings(message.settings);
        break;
      case "MEDIA_STATE":
        renderSong(message.state);
        break;
      case "SONG_CHANGED":
        if (message.videoKey !== currentVideoKey) {
          currentVideoKey = message.videoKey;
          sheet.reset();
          lyricsStatus = [];
          chordsStatus = [];
          updateSheetStatus();
          sheet.showEmpty("Looking for lyrics…");
          clearChords();
          // While capturing, the offscreen document runs the same lookup and
          // broadcasts the result; idle, this is the only chord path.
          if (!isActive) requestChart();
        }
        break;
      case "CHORD_CHART":
        // The offscreen document's persist/broadcast tail can outlive a song
        // change; a late chart from the previous song must not paint the new
        // one. Older broadcasts without a videoKey pass through.
        if (message.videoKey && currentVideoKey && message.videoKey !== currentVideoKey) break;
        setChordState({
          tier: message.tier,
          chords: message.chords || [],
          key: message.key || null,
          tuning: message.tuning || 0,
          coverage: message.coverage || 0,
          progress: message.progress || 0,
          source: message.source || "local",
        });
        break;
      case "PLAYBACK_TIME":
        sheet.onPlayback(message);
        break;
      case "CAPTURE_ACTIVE":
        renderCaptureState(true);
        if (message.latencySamples && message.sampleRate) {
          const ms = (message.latencySamples / message.sampleRate) * 1000;
          els.latencyNote.textContent =
            `${message.sampleRate / 1000} kHz · ${ms.toFixed(1)} ms latency`;
        }
        break;
      case "DISPLAY_MEDIA_FAILED":
        renderCaptureState(false, {
          error: message.reason === "no-audio"
            ? "Tick “Share audio” in the picker for this to work."
            : "Capture was cancelled.",
        });
        break;
    }
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function activeTabId() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab && tab.url && /^https?:/.test(tab.url) ? tab.id : null;
    } catch {
      return null;
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  (async function init() {
    // Seed the mode hint from the markup's own default. Without this the hint
    // is blank whenever GET_STATE answers with no stored settings — a fresh
    // install, or an evicted SW that has not finished recovering.
    els.modeHint.textContent = MODE_HINTS[els.modeSelect.value] || "";

    // The panel is pinned to one tab; the SW records which in storage.session
    // so a reopened panel controls the tab it was opened on, not whichever is
    // in front now.
    try {
      const { boundTabId } = await chrome.storage.session.get({ boundTabId: null });
      pinnedTabId = boundTabId;
    } catch {}

    const state = await sendMessage({ type: "GET_STATE" });
    if (state) {
      renderCaptureState(!!state.isActive);
      renderSettings(state.settings);
      if (state.tabId != null) pinnedTabId = state.tabId;
    } else {
      renderCaptureState(false);
    }

    const tabId = pinnedTabId != null ? pinnedTabId : await activeTabId();
    if (tabId == null) {
      sheet.showEmpty("No media on this tab");
      return;
    }
    pinnedTabId = tabId;
    sheet.showEmpty("Looking for media…");
    chrome.tabs.sendMessage(tabId, { type: "GET_MEDIA_STATE" }, (res) => {
      void chrome.runtime.lastError;   // no content script on this page
      if (res) {
        currentVideoKey = res.videoKey || null;
        renderSong(res);
        // A freshly opened panel has missed any CHORD_CHART broadcast; the SW
        // cache answers this instantly when one already resolved.
        requestChart();
      } else {
        sheet.showEmpty("Reload the tab to enable lyrics");
      }
    });

    try {
      const { ifDiagramTray } = await chrome.storage.local.get({ ifDiagramTray: false });
      trayOpen = !!ifDiagramTray;
    } catch {}
  })();
})();
