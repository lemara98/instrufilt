// Instrufilt — the offscreen document owns the entire audio graph.
//
// Forked from Karafilt's offscreen.js. The graph and both capture paths are
// unchanged; what differs is the parameter set (isolation modes and amount
// rather than removal mode and mix) and the fact that this document will later
// also own the chord accumulator.
//
// That last point is worth stating early, because it drives the design: this
// document has exactly the right lifetime for buffering an analysis. It lives
// as long as the capture does. The service worker gets evicted mid-song while
// audio keeps flowing (which is the whole reason Karafilt mirrors state into
// storage.session), and the side panel can be closed at any moment. Neither is
// a safe place to accumulate anything.

const IF_DEBUG = false;
const dbg = (...args) => { if (IF_DEBUG) console.log("[if/offscreen]", ...args); };

const DEFAULT_MODE = "vocal_rhythm";

let audioContext = null;
let workletNode = null;
let sourceNode = null;
let mediaStream = null;
let captureReady = false;
let capturedTabId = null;

let currentMode = DEFAULT_MODE;
let currentAmount = 1.0;
let currentMakeupDb = null;
let currentAutoGain = false;
let currentMono = false;
// -1 = let the mode decide (0.85 / 0.00 / 0.95). Overridable so the REPET stage
// can be A/B'd against the rest of the mask without changing anything else.
let currentRepet = -1;

chrome.runtime.onMessage.addListener((message, sender) => {
  // Content-script messages are mostly not for us — except the media clock and
  // song boundaries, which the chord accumulator needs and which only a content
  // script can observe. Filtered to the captured tab, so a second tab playing
  // audio cannot corrupt this one's chart.
  if (sender.tab) {
    if (capturedTabId === null || sender.tab.id !== capturedTabId) return;
    switch (message.type) {
      case "PLAYBACK_TIME": onPlaybackTime(message); break;
      case "SONG_CHANGED":  onSongChanged(message.videoKey); break;
      case "MEDIA_STATE":   if (message.state) onMediaState(message.state); break;
    }
    return;
  }

  switch (message.type) {
    case "STREAM_READY":
      capturedTabId = message.tabId != null ? message.tabId : null;
      applySettings(message.settings);
      startCapture(message.streamId);
      break;

    case "START_VIA_DISPLAY_MEDIA":
      capturedTabId = message.tabId != null ? message.tabId : null;
      applySettings(message.settings);
      startCaptureViaDisplayMedia();
      break;

    case "STOP_CAPTURE":
      stopCapture();
      break;

    case "SET_AMOUNT":
      currentAmount = message.value;
      post({ type: "SET_AMOUNT", value: message.value });
      break;

    case "SET_MODE":
      currentMode = message.value || DEFAULT_MODE;
      post({ type: "SET_MODE", value: currentMode });
      break;

    case "SET_MAKEUP_DB":
      currentMakeupDb = message.value;
      post({ type: "SET_MAKEUP_DB", value: message.value });
      break;

    case "SET_AUTO_GAIN":
      currentAutoGain = !!message.value;
      post({ type: "SET_AUTO_GAIN", value: currentAutoGain });
      break;

    case "SET_MONO":
      currentMono = !!message.value;
      post({ type: "SET_MONO", value: currentMono });
      break;

    case "SET_REPET":
      currentRepet = typeof message.value === "number" ? message.value : -1;
      post({ type: "SET_REPET", value: currentRepet });
      break;

    case "SET_CHORDS_ENABLED":
      chordsEnabled = !!message.value;
      // Through the gate, not raw: toggling chords off/on while a verified
      // external chart is active (or during an ad, or paused) must not switch
      // the worklet's analysis back on past those guards.
      syncChromaEnabled();
      break;

    case "REANALYZE":
      // Forget what we know about this song and listen again from scratch.
      discardChart();
      break;
  }
});

function post(msg) {
  if (workletNode) workletNode.port.postMessage(msg);
}

function applySettings(s) {
  if (!s) return;
  if (typeof s.mode === "string") currentMode = s.mode;
  if (typeof s.amount === "number") currentAmount = s.amount;
  if (typeof s.makeupDb === "number") currentMakeupDb = s.makeupDb;
  if (typeof s.autoGain === "boolean") currentAutoGain = s.autoGain;
  if (typeof s.mono === "boolean") currentMono = s.mono;
  if (typeof s.repet === "number") currentRepet = s.repet;
  if (typeof s.chords === "boolean") chordsEnabled = s.chords;
}

// Build the graph from an already-acquired MediaStream. Shared by the
// tabCapture path (Chrome, no picker) and getDisplayMedia (Brave/Edge).
// Callers must cleanupAudio() first.
async function startCaptureFromMediaStream(stream) {
  mediaStream = stream;

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();

  const wasmUrl = chrome.runtime.getURL("wasm/build/vocal_isolate.wasm");
  const wasmModule = await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer());

  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("worklet-processor.js"));

  workletNode = new AudioWorkletNode(audioContext, "vocal-isolate-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      // A WebAssembly.Module is structured-cloneable, so the audio thread never
      // has to fetch anything.
      wasmModule,
      sampleRate: audioContext.sampleRate,
      // Seeded here rather than sent afterwards: a SET_* message can arrive
      // before the worklet's async WASM init finishes and be silently dropped.
      mode: currentMode,
      amount: currentAmount,
      makeupDb: currentMakeupDb,
      autoGain: currentAutoGain,
      mono: currentMono,
      repet: currentRepet,
      chroma: chromaShouldRun(),
    },
  });

  workletNode.port.onmessage = (event) => {
    const d = event.data || {};
    switch (d.type) {
      case "WORKLET_READY":
        dbg(`ready @${d.sampleRate}Hz, latency ${d.latencySamples} samples`);
        chrome.runtime.sendMessage({
          type: "CAPTURE_ACTIVE",
          sampleRate: d.sampleRate,
          latencySamples: d.latencySamples,
        }).catch(() => {});
        break;
      case "CHROMA_FRAMES":
        onChromaFrames(d);
        break;
      case "CHORD_EVENTS":
        lastTuning = d.tuning;
        onChordEvents(d);
        break;
    }
  };

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // source -> worklet -> destination. tabCapture mutes the original tab
  // output, so this node is what the user actually hears.
  sourceNode.connect(workletNode);
  workletNode.connect(audioContext.destination);

  captureReady = true;
  dbg(`capture started @${audioContext.sampleRate}Hz, mode "${currentMode}"`);
}

async function startCapture(streamId) {
  try {
    cleanupAudio();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
    await startCaptureFromMediaStream(stream);
  } catch (err) {
    console.error("[if/offscreen] capture failed:", err && err.message);
    chrome.runtime.sendMessage({
      type: "CAPTURE_FAILED",
      reason: String((err && err.message) || err),
    }).catch(() => {});
  }
}

// Brave rejects tabCapture's getMediaStreamId when it originates from a
// side-panel click, so fall back to the Web standard. All Chromium browsers
// show a "Choose what to share" picker here.
async function startCaptureViaDisplayMedia() {
  try {
    cleanupAudio();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Without suppressLocalAudioPlayback this is only a tap: the original,
      // unprocessed tab audio keeps playing alongside our output.
      audio: { suppressLocalAudioPlayback: true },
      video: true, // required by spec; dropped immediately below
    });
    stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch {} });

    if (stream.getAudioTracks().length === 0) {
      // The user shared a tab but left "Share audio" unchecked.
      stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      chrome.runtime.sendMessage({ type: "DISPLAY_MEDIA_FAILED", reason: "no-audio" }).catch(() => {});
      return;
    }
    await startCaptureFromMediaStream(stream);
  } catch (err) {
    // Also fires when the user cancels the picker. The SW sets capture state
    // optimistically before opening the dialog, so it needs to roll back.
    chrome.runtime.sendMessage({
      type: "DISPLAY_MEDIA_FAILED",
      reason: String((err && err.message) || err),
    }).catch(() => {});
  }
}

// ── chord accumulation ──────────────────────────────────────────────────────
//
// This document owns the chord buffer because its lifetime is exactly right: it
// lives as long as the capture. The service worker is evicted mid-song while
// audio keeps flowing, and the side panel can be closed at any moment — buffer
// an analysis in either and it silently disappears part-way through a song.

const FRAME_FLOATS = 28;
// Chroma frames are only needed for the end-of-song re-decode; ~6000 of them
// for a four-minute song is a few hundred KB, which is fine in memory and would
// not be fine in storage.
const MAX_FRAMES = 20000;
// A jump larger than this in the audio->media offset is a seek, not drift.
const SEEK_JUMP_SEC = 0.5;
// Frames within this of a seek are dropped: the 8192-sample analysis window
// straddles the discontinuity and describes neither side.
const SEEK_BLIND_SEC = 0.35;
const OFFSET_WINDOW = 15;
const CHECKPOINT_MS = 30000;

let chordsEnabled = true;
let frames = [];              // {t: mediaTime, chroma: Float32Array, bass: Float32Array}
let liveChords = [];          // causal events, for the "Listening" tier
let currentVideoKey = null;
let currentDuration = 0;
let mediaOffsets = [];        // recent (mediaTime - audioTime) samples
let mediaOffset = null;
let lastMediaTime = 0;
let coverStart = null;
let coverSpans = [];
let blindUntilAudioTime = -1;
let checkpointTimer = null;
let isPaused = true;
let isAd = false;
let finalized = false;
// True when the current chart came from a verified external source (Songle).
// Accumulating frames for a song that already has a verified chart burns CPU
// for a strictly worse answer — and persisting that answer would clobber the
// verified one.
let externalChart = false;

function chromaShouldRun() {
  // Silent, advertising, or switched off: all three would write nonsense into
  // the chart, and an ad is the worst of them because it is confidently
  // harmonic nonsense. A verified external chart makes listening pointless.
  return chordsEnabled && !isPaused && !isAd && !externalChart;
}

function syncChromaEnabled() {
  post({ type: "SET_CHROMA", value: chromaShouldRun() });
}

function onPlaybackTime(msg) {
  // Capture often starts MID-SONG, when the content script has no reason to
  // re-announce SONG_CHANGED or MEDIA_STATE — so the ticker is the only
  // message guaranteed to carry the song identity. Without this seed,
  // currentVideoKey stays null for the whole first song: no existing chart is
  // loaded (live "listening" then clobbers a Songle chart the panel already
  // shows), the song's analysis is discarded unsaved, and REANALYZE cannot
  // delete anything.
  if (msg.videoKey && msg.videoKey !== currentVideoKey) onSongChanged(msg.videoKey);

  isPaused = !!msg.paused;
  if (typeof msg.duration === "number" && msg.duration > 0) currentDuration = msg.duration;

  if (!audioContext) return;

  const audioTime = audioContext.currentTime;
  const offset = msg.time - audioTime;

  if (mediaOffset !== null && Math.abs(offset - mediaOffset) > SEEK_JUMP_SEC) {
    // A seek. The rolling analysis window now spans two unrelated moments, so
    // reset it and blind the accumulator briefly rather than recording frames
    // that describe the splice.
    closeCoverage();
    mediaOffsets = [];
    post({ type: "RESET_CHROMA" });
    post({ type: "RESET_REPET" });
    blindUntilAudioTime = audioTime + SEEK_BLIND_SEC;
  }

  // Median of a short window, not the latest value: individual samples jitter
  // by tens of milliseconds because the content script's 200 ms tick and this
  // document's clock are unrelated, and that jitter would land directly on
  // every chord timestamp.
  mediaOffsets.push(offset);
  if (mediaOffsets.length > OFFSET_WINDOW) mediaOffsets.shift();
  const sorted = mediaOffsets.slice().sort((a, b) => a - b);
  mediaOffset = sorted[sorted.length >> 1];

  lastMediaTime = msg.time;
  if (!isPaused && coverStart === null) coverStart = msg.time;
  if (isPaused) closeCoverage();

  syncChromaEnabled();
}

function onMediaState(state) {
  const wasAd = isAd;
  isAd = !!state.isAd;
  if (isAd !== wasAd) {
    if (isAd) closeCoverage();
    // An ad replaces the audio entirely; the window must not span the join.
    post({ type: "RESET_CHROMA" });
    post({ type: "RESET_REPET" });
    syncChromaEnabled();
  }
  if (state.videoKey && state.videoKey !== currentVideoKey) onSongChanged(state.videoKey);
}

function closeCoverage() {
  if (coverStart !== null && lastMediaTime > coverStart) {
    coverSpans.push([coverStart, lastMediaTime]);
  }
  coverStart = null;
}

function onSongChanged(videoKey) {
  if (videoKey === currentVideoKey) return;
  finalizeChart();                      // whatever we learned about the old one
  currentVideoKey = videoKey || null;
  resetAccumulator();
  post({ type: "RESET_CHROMA" });
  post({ type: "RESET_REPET" });
  loadExistingChart();
  // Note: discardChart() deliberately does NOT reset REPET. Throwing away a
  // chart invalidates the chroma accumulator, not the audio timeline, and a
  // needless reset would cost 3 s of degraded isolation mid-song.
}

function resetAccumulator() {
  frames = [];
  liveChords = [];
  coverSpans = [];
  coverStart = null;
  mediaOffsets = [];
  mediaOffset = null;
  currentDuration = 0;
  finalized = false;
  externalChart = false;
  blindUntilAudioTime = -1;
}

function discardChart() {
  if (currentVideoKey) InstrufiltChordSource.deleteChart(currentVideoKey);
  resetAccumulator();
  post({ type: "RESET_CHROMA" });
  // externalChart just went false; the worklet may need switching back on.
  syncChromaEnabled();
  broadcastChart({ tier: "listening", chords: [] });
}

// Resolution goes through the SW (FETCH_CHART) rather than calling
// resolveChart here: the SW owns the network path (Songle) exactly as it owns
// the lyrics path, and its LRU means the panel's own request for the same song
// costs nothing. This document keeps the storage.local writes — the
// accumulator's lifetime argument is about WRITING analyses, not reading.
async function loadExistingChart() {
  if (!currentVideoKey) return;
  const requestedKey = currentVideoKey;
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: "FETCH_CHART",
      videoKey: requestedKey,
      durationSec: currentDuration,
    });
  } catch {}
  // The song may have changed while the SW resolved; a stale chart must not
  // land on the new song.
  if (!res || !res.found || currentVideoKey !== requestedKey) return;

  // A complete chart supersedes the listening pass: without this, every
  // causal chord event re-broadcast "listening" on top of the chart the panel
  // had just rendered. A PARTIAL local chart deliberately keeps the live pass
  // running — "renders the half it knows and keeps going live for the rest"
  // (chord-source.js). 0.85 is the same threshold the panel's tier pill uses.
  // "External" is any non-local provenance — Songle AND Karalyr — so the
  // persistChart guard protects both from being clobbered by a local
  // re-decode, and the worklet stops burning CPU on a song that already has
  // a verified chart.
  const isExternal = !!res.source && res.source !== "local";
  if (isExternal || res.coverage >= 0.85) {
    finalized = true;
  } else {
    // Seed the live buffer with the known half, marked non-live, so the next
    // listening broadcast carries cached knowledge PLUS what is being heard —
    // instead of wiping the sheet down to the few seconds heard since load.
    liveChords = (res.chords || []).map((c) => ({ ...c, live: false }));
  }
  if (isExternal) {
    externalChart = true;
    syncChromaEnabled();
  }
  broadcastChart({
    videoKey: requestedKey,
    tier: "chart",
    chords: res.chords,
    key: res.key,
    tuning: res.tuning,
    coverage: res.coverage,
    source: res.source,
  });
}

function onChromaFrames(msg) {
  if (mediaOffset === null || !audioContext) return;
  if (audioContext.currentTime < blindUntilAudioTime) return;
  if (!chromaShouldRun()) return;

  const data = new Float32Array(msg.data);
  for (let i = 0; i < msg.count; i++) {
    const base = i * FRAME_FLOATS;
    // Frame times arrive on the isolation INPUT timeline (chroma.c already
    // folds out its own window centring and the isolation group delay), so the
    // only remaining conversion is audio clock -> media clock.
    const t = data[base] + mediaOffset;
    if (t < 0) continue;
    if (frames.length >= MAX_FRAMES) break;
    frames.push({
      t,
      chroma: data.slice(base + 2, base + 14),
      bass: data.slice(base + 14, base + 26),
    });
  }
  scheduleCheckpoint();
}

function onChordEvents(msg) {
  if (mediaOffset === null) return;
  if (!chromaShouldRun()) return;
  for (const e of msg.events) {
    if (e.root < 0) continue;                 // N: a break, not a chord to show
    liveChords.push({
      t: e.t + mediaOffset,
      root: e.root,
      quality: e.quality,
      confidence: e.conf,
      live: true,
    });
  }
  // Only useful before a chart exists; afterwards the cached chart is better in
  // every way and this would just flicker underneath it.
  if (!finalized) {
    broadcastChart({
      tier: "listening",
      chords: liveChords,
      progress: currentDuration > 0 ? lastMediaTime / currentDuration : 0,
    });
  }
}

function scheduleCheckpoint() {
  if (checkpointTimer) return;
  // Debounced, never per event. A crash or a closed tab loses at most 30 s of
  // analysis instead of the whole song.
  checkpointTimer = setTimeout(() => {
    checkpointTimer = null;
    persistChart(false);
  }, CHECKPOINT_MS);
}

function buildChart() {
  if (frames.length < 20) return null;

  const segments = InstrufiltChordDecode.decode(frames);
  const key = InstrufiltChordFormat.estimateKey(
    InstrufiltChordDecode.aggregateChroma(frames)
  );

  closeCoverage();
  const covered = InstrufiltChordSource.mergeCovered(coverSpans);
  if (coverStart !== null) coverStart = lastMediaTime;   // reopen for what follows

  return InstrufiltChordSource.makeChart({
    videoKey: currentVideoKey,
    durationSec: currentDuration,
    tuning: lastTuning,
    key,
    chords: segments,
    covered,
  });
}

let lastTuning = 0;

async function persistChart(final) {
  // Everything up to the first await runs synchronously, so the chart is
  // built against the song this call was made for — but the tail of this
  // function resumes AFTER onSongChanged may have moved on to the next song.
  const videoKey = currentVideoKey;
  if (!videoKey) return;
  // A verified external chart must never be clobbered by a local re-decode;
  // REANALYZE (discardChart) is the deliberate way back to local analysis.
  if (externalChart) return;
  const chart = buildChart();
  if (!chart) return;
  chart.analyzedAt = Date.now();
  await InstrufiltChordSource.saveChart(chart);
  // The SW's chart LRU may hold a miss (or an older chart) for this song.
  chrome.runtime.sendMessage({ type: "CHART_SAVED", videoKey: chart.videoKey }).catch(() => {});
  // Song changed while we were saving: the chart is safely on disk for the
  // next play, but `finalized` now describes the NEW song and a broadcast
  // would paint the old song's chords onto it.
  if (currentVideoKey !== videoKey) return;
  if (final) {
    finalized = true;
    broadcastChart({
      videoKey,
      tier: "chart",
      chords: InstrufiltChordSource.expandChords(chart),
      key: chart.keyPc === null ? null : { pc: chart.keyPc, mode: chart.keyMode },
      tuning: chart.tuning,
      coverage: InstrufiltChordSource.coverageFraction(chart),
      source: "local",
    });
  }
}

function finalizeChart() {
  if (checkpointTimer) { clearTimeout(checkpointTimer); checkpointTimer = null; }
  if (frames.length >= 20) persistChart(true);
}

function broadcastChart(payload) {
  // Every chart broadcast names its song so the panel can drop late arrivals
  // from a song the user has already skipped past.
  chrome.runtime.sendMessage({
    type: "CHORD_CHART",
    videoKey: currentVideoKey,
    ...payload,
  }).catch(() => {});
}

self.addEventListener("pagehide", () => { try { finalizeChart(); } catch {} });

function cleanupAudio() {
  captureReady = false;
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); workletNode = null; }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    mediaStream = null;
  }
  if (audioContext) { audioContext.close(); audioContext = null; }
}

function stopCapture() {
  dbg("stopCapture");
  finalizeChart();
  cleanupAudio();
  capturedTabId = null;
  resetAccumulator();
  currentVideoKey = null;
}
