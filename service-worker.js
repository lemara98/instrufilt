// Instrufilt — capture lifecycle and side-panel orchestration.
//
// Forked from Karafilt's service-worker.js, keeping the parts that took real
// debugging to get right and dropping everything Instrufilt does not have yet
// (lyrics lookup, party mode, ratings, usage telemetry). Those arrive with
// their phases; the capture chassis below is the load-bearing part.
//
// Two hard-won behaviours are preserved verbatim in spirit:
//
//   * USER GESTURE FRAGILITY. chrome.tabCapture.getMediaStreamId only works
//     inside a live user invocation. Any `await` before it silently kills the
//     grant, which is why the command and context-menu paths call it with no
//     preceding await, and why the side panel delegates to the SW instead of
//     calling it itself.
//
//   * MV3 EVICTION. The SW is evicted while the offscreen document keeps
//     processing audio. In-memory state does not survive; storage.session is
//     mirrored so a restarted SW can recover, but the mirror is only trusted
//     when getContexts() confirms the offscreen document is genuinely alive.

importScripts("shared/song-match.js", "shared/lyrics-fetch.js", "shared/chord-format.js", "shared/chord-source.js", "shared/songle-fetch.js", "shared/karalyr-fetch.js");

// Aliased at the point of use rather than renamed during vendoring — see
// vendor/MANIFEST.json for why the Karafilt* names are kept.
const SM = self.KarafiltSongMatch;
const LF = self.InstrufiltLyricsFetch;
const CS = self.InstrufiltChordSource;
const KF = self.InstrufiltKaralyrFetch;

const IF_DEBUG = false;
const dbg = (...args) => { if (IF_DEBUG) console.log("[if/sw]", ...args); };

const DEFAULTS = {
  mode: "vocal_rhythm",   // vocal_only | vocal_rhythm | lead_line
  amount: 100,            // 0..100, isolation blend
  makeupDb: null,         // null = use the mode's own makeup
  autoGain: false,
  mono: false,
  repet: -1,              // -1 = use the mode's own REPET strength; 0 disables it
  chords: true,           // on-device chord detection
  onlineChords: true,     // fetch charts from Karalyr/Songle (metadata only —
                          // the "no audio ever leaves the browser" promise holds)
  instrument: "guitar",   // for the "How to play" tutorial search query
};

// The online-chords toggle originally shipped as "songleChords"; renamed when
// Karalyr became a chord source too (one toggle gates every network
// provider, so a Songle-specific name would have silently disabled Karalyr).
function migrateStoredSettings(stored) {
  if (!stored || typeof stored !== "object") return stored;
  if ("songleChords" in stored && !("onlineChords" in stored)) {
    stored.onlineChords = stored.songleChords !== false;
  }
  delete stored.songleChords;
  return stored;
}

let capturedTabId = null;
let capturedTabUrl = null;
let settings = { ...DEFAULTS };
let creatingOffscreen = null;

// ── settings ────────────────────────────────────────────────────────────────

function settingsForWorklet() {
  return {
    mode: settings.mode,
    amount: clamp01(settings.amount / 100),
    makeupDb: typeof settings.makeupDb === "number" ? settings.makeupDb : undefined,
    autoGain: !!settings.autoGain,
    mono: !!settings.mono,
    repet: typeof settings.repet === "number" ? settings.repet : -1,
    chords: settings.chords !== false,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function persistSettings() {
  chrome.storage.local.set({ ifSettings: settings });
  // Mirrored to session as well: local survives restarts, session is what a
  // freshly-restarted SW reads to report the filter's REAL state rather than
  // defaults while audio is still running.
  chrome.storage.session.set({ ifSettingsMirror: settings });
}

async function loadSettings() {
  const { ifSettings } = await chrome.storage.local.get({ ifSettings: null });
  if (ifSettings) settings = { ...DEFAULTS, ...migrateStoredSettings(ifSettings) };
  const { ifSettingsMirror } = await chrome.storage.session.get({ ifSettingsMirror: null });
  if (ifSettingsMirror) settings = { ...settings, ...migrateStoredSettings(ifSettingsMirror) };
}

// ── capture state, mirrored for eviction ────────────────────────────────────

function setCapturedTab(id, url) {
  capturedTabId = id;
  capturedTabUrl = url;
  if (id === null) chrome.storage.session.remove("capturedTab", () => void chrome.runtime.lastError);
  else chrome.storage.session.set({ capturedTab: { id, url } });
  updateBadge();
}

function updateBadge() {
  const on = capturedTabId !== null;
  chrome.action.setBadgeText({ text: on ? "ON" : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#38b2ac" }).catch(() => {});
}

async function recoverCaptureState() {
  try {
    await loadSettings();
    const { capturedTab } = await chrome.storage.session.get({ capturedTab: null });
    if (!capturedTab || capturedTabId !== null) return;

    // Only trust the mirror while the offscreen document — the thing actually
    // producing audio — is still alive. Otherwise the capture really did end
    // with the previous SW generation, and restoring it would leave the panel
    // showing an active filter that isn't running.
    let offscreenAlive = true;
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      offscreenAlive = !!(contexts && contexts.length > 0);
    }
    if (capturedTabId !== null) return;  // a capture started while we awaited

    if (offscreenAlive) {
      capturedTabId = capturedTab.id;
      capturedTabUrl = capturedTab.url;
      updateBadge();
    } else {
      chrome.storage.session.remove("capturedTab", () => void chrome.runtime.lastError);
    }
  } catch (e) {
    console.warn("[if/sw] recoverCaptureState failed:", e);
  }
}

const captureStateReady = recoverCaptureState();

// ── offscreen document ──────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts && contexts.length > 0) return;
  }
  // Concurrent starts would otherwise race and throw "Only a single offscreen
  // document may be created".
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification: "Process captured tab audio to isolate the lead vocal.",
  });
  try {
    await creatingOffscreen;
  } catch (err) {
    if (!String(err && err.message).includes("single offscreen")) throw err;
  } finally {
    creatingOffscreen = null;
  }
}

// ── starting and stopping ───────────────────────────────────────────────────

async function handleStartCapture(tabId, providedStreamId) {
  try {
    if (capturedTabId !== null && capturedTabId !== tabId) {
      chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
      // Karafilt found the offscreen document needs a beat to tear the old
      // graph down before the next getUserMedia, or the new stream can arrive
      // while the old AudioContext is still closing.
      await new Promise((r) => setTimeout(r, 300));
    }

    await ensureOffscreenDocument();

    const streamId = providedStreamId
      || await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    let url = null;
    try { url = (await chrome.tabs.get(tabId)).url; } catch {}

    setCapturedTab(tabId, url);

    chrome.runtime.sendMessage({
      type: "STREAM_READY",
      streamId,
      tabId,
      settings: settingsForWorklet(),
    }).catch(() => {});

    return { success: true };
  } catch (err) {
    console.error("[if/sw] handleStartCapture failed:", err && err.message);
    setCapturedTab(null, null);
    return { success: false, error: String((err && err.message) || err) };
  }
}

// Brave and Edge reject getMediaStreamId when the gesture came from a side
// panel. getDisplayMedia works everywhere but shows a picker, so it is the
// fallback rather than the default.
async function handleStartCaptureViaDisplayMedia(tabId) {
  try {
    await ensureOffscreenDocument();
    let url = null;
    try { url = (await chrome.tabs.get(tabId)).url; } catch {}
    // Set optimistically so the panel can show "starting"; DISPLAY_MEDIA_FAILED
    // rolls it back if the user cancels the picker.
    setCapturedTab(tabId, url);
    chrome.runtime.sendMessage({
      type: "START_VIA_DISPLAY_MEDIA",
      tabId,
      settings: settingsForWorklet(),
    }).catch(() => {});
    return { success: true };
  } catch (err) {
    setCapturedTab(null, null);
    return { success: false, error: String((err && err.message) || err) };
  }
}

function stopCapture() {
  setCapturedTab(null, null);
  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
  broadcastState(false);
}

function broadcastState(isActive) {
  chrome.runtime.sendMessage({
    type: "CAPTURE_STATE",
    isActive,
    tabId: capturedTabId,
    settings,
  }).catch(() => {});
}

// Must run synchronously inside an invocation handler — no await before
// getMediaStreamId, or the activeTab grant is gone by the time it is called.
function toggleCaptureForTab(tab) {
  if (!isEligible(tab)) return;
  if (capturedTabId === tab.id) { stopCapture(); return; }
  chrome.tabCapture
    .getMediaStreamId({ targetTabId: tab.id })
    .then(async (streamId) => {
      const result = await handleStartCapture(tab.id, streamId);
      if (result.success) broadcastState(true);
    })
    .catch(async (err) => {
      dbg("getMediaStreamId rejected, falling back to display media:", err && err.message);
      const result = await handleStartCaptureViaDisplayMedia(tab.id);
      if (result.success) broadcastState(true);
    });
}

function isEligible(tab) {
  return !!(tab && tab.id && tab.url && /^https?:/.test(tab.url));
}

// ── side panel ──────────────────────────────────────────────────────────────

// Disabled by default and enabled per tab, so the panel appears only where the
// user asked for it rather than on every tab in the browser. Both calls run on
// every SW start so the defaults survive restarts.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});

// Fire-and-forget by design: callers are inside a user gesture and must not
// await before their own gesture-bound calls.
function bindPanelToTab(tabId) {
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel/sidepanel.html", enabled: true })
    .catch((err) => console.error("[if/sw] sidePanel enable failed:", err));
  chrome.storage.session.get({ boundTabId: null }, ({ boundTabId }) => {
    if (boundTabId != null && boundTabId !== tabId) {
      chrome.sidePanel.setOptions({ tabId: boundTabId, enabled: false }).catch(() => {});
    }
    chrome.storage.session.set({ boundTabId: tabId });
  });
}

function flashIneligibleBadge(tabId) {
  chrome.action.setBadgeText({ text: "✕", tabId }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 2000);
}

// Clicking the icon opens the panel but does NOT start isolating — the user
// presses Start, and that click's activeTab grant is what lets us capture
// without a picker.
chrome.action.onClicked.addListener((tab) => {
  if (!isEligible(tab)) {
    if (tab && tab.id) flashIneligibleBadge(tab.id);
    return;
  }
  bindPanelToTab(tab.id);
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  // Moving the panel to a new tab must stop isolation on the old one, or the
  // panel's Start/Stop state would describe a tab it is no longer attached to.
  if (capturedTabId !== null && capturedTabId !== tab.id) stopCapture();
});

// ── commands and context menu ───────────────────────────────────────────────

// Alt+Shift+I, not Ctrl+Shift+I — that is DevTools on every platform.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-isolate") return;
  if (isEligible(tab)) {
    bindPanelToTab(tab.id);
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
  toggleCaptureForTab(tab);
});

const MENU_ID = "instrufilt-isolate-this-tab";

function setupContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      chrome.contextMenus.create({
        id: MENU_ID,
        title: "Isolate vocals on this tab",
        contexts: ["page"],
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      }, () => void chrome.runtime.lastError);
    });
  } catch (e) {
    console.warn("[if/sw] context menu setup failed:", e);
  }
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

// A context-menu click carries the activeTab grant tabCapture needs, so this is
// the reliable no-picker path on browsers where the panel button is not.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !isEligible(tab)) return;
  bindPanelToTab(tab.id);
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  toggleCaptureForTab(tab);
});

// ── tab lifecycle ───────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturedTabId) stopCapture();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== capturedTabId || !changeInfo.url) return;
  // Same-page navigations (YouTube's SPA router) keep the capture; leaving the
  // origin entirely does not.
  try {
    if (new URL(changeInfo.url).origin !== new URL(capturedTabUrl || "").origin) stopCapture();
    else capturedTabUrl = changeInfo.url;
  } catch {
    stopCapture();
  }
});

// ── lyrics ──────────────────────────────────────────────────────────────────

// Small in-memory LRU. The key includes the video key so the same parsed name
// can resolve differently on different videos — a live version and a studio
// version share a title but not their timing.
const lyricsCache = new Map();
const LYRICS_CACHE_MAX = 50;

function cacheKey(q) {
  return `${q.videoKey || ""}|${(q.artist || "").toLowerCase()}|${(q.track || "").toLowerCase()}`;
}

function cacheGet(q) {
  const k = cacheKey(q);
  if (!lyricsCache.has(k)) return null;
  const v = lyricsCache.get(k);
  lyricsCache.delete(k);      // re-insert to refresh LRU position
  lyricsCache.set(k, v);
  return v;
}

function cachePut(q, value) {
  const k = cacheKey(q);
  lyricsCache.set(k, value);
  while (lyricsCache.size > LYRICS_CACHE_MAX) {
    lyricsCache.delete(lyricsCache.keys().next().value);
  }
}

// Let a local Karalyr be pointed at for development, the same way Karafilt
// does. One override drives both consumers — lyrics and chord charts come
// from the same server.
chrome.storage.local.get({ karalyrBase: null }).then(({ karalyrBase }) => {
  if (karalyrBase) {
    LF.setKaralyrBase(karalyrBase);
    KF.setKaralyrBase(karalyrBase);
  }
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.karalyrBase) {
    LF.setKaralyrBase(changes.karalyrBase.newValue);
    KF.setKaralyrBase(changes.karalyrBase.newValue);
  }
});

async function handleFetchLyrics(message) {
  const q = {
    artist: message.artist || "",
    track: message.track || "",
    album: message.album || "",
    durationSec: message.durationSec || 0,
    videoKey: message.videoKey || null,
  };

  if (!message.forceRefresh) {
    const hit = cacheGet(q);
    if (hit) return hit;
  }

  let result;
  try {
    result = await LF.lookup(q, { karalyrOnly: !!message.karalyrOnly });
  } catch (err) {
    console.warn("[if/sw] lyrics lookup failed:", err && err.message);
    result = { found: false };
  }

  // Phase-1 (karalyrOnly) misses are deliberately NOT cached: caching them
  // would short-circuit phase 2, which is the pass that actually runs LRCLib.
  if (result.found || !message.karalyrOnly) cachePut(q, result);
  return result;
}

// ── chord charts ────────────────────────────────────────────────────────────

// Request/response twin of FETCH_LYRICS, and for the same reason the fetch
// lives here: cross-origin needs the SW's host permissions, and the resolver
// must work before capture starts (chords-without-Start) and after the panel
// closes. Both the offscreen document and the panel ask; the LRU below makes
// the second ask free and — because misses are cached too — stops the SW from
// re-probing Songle every time the user revisits a song it does not have.
const chartCache = new Map();
const CHART_CACHE_MAX = 50;
// Bumped by CHART_SAVED/REANALYZE. A resolve that started before the bump
// must not cache its (now stale) answer after it — classic check-then-write.
let chartCacheGeneration = 0;

async function handleFetchChart(message) {
  const videoKey = message.videoKey || null;
  if (!videoKey) return { found: false, videoKey };

  // A FETCH_CHART is often the event that woke an evicted SW; without this a
  // fresh SW would read the DEFAULT onlineChords and contact Karalyr/Songle
  // even though the user has switched online chords off.
  await captureStateReady;
  const allowNetwork = settings.onlineChords !== false;
  const cacheK = `${videoKey}|${allowNetwork ? 1 : 0}`;
  if (chartCache.has(cacheK)) {
    const hit = chartCache.get(cacheK);
    chartCache.delete(cacheK);
    chartCache.set(cacheK, hit);      // refresh LRU position
    return hit;
  }

  const generationAtStart = chartCacheGeneration;
  let got = null;
  try {
    got = await CS.resolveChart(videoKey, {
      allowNetwork,
      durationSec: message.durationSec || 0,
    });
  } catch (err) {
    console.warn("[if/sw] chart lookup failed:", err && err.message);
  }

  const response = !got ? { found: false, videoKey } : {
    found: true,
    videoKey,
    tier: "chart",
    // Provenance survives the cache: a songle chart answered by cacheProvider
    // is still a songle chart, and the attribution the terms require hangs off
    // this field.
    source: got.chart.source || "local",
    chords: CS.expandChords(got.chart),
    key: got.chart.keyPc === null ? null : { pc: got.chart.keyPc, mode: got.chart.keyMode },
    tuning: got.chart.tuning || 0,
    coverage: CS.coverageFraction(got.chart),
  };

  // Serve the answer regardless, but only CACHE it if nothing was saved or
  // discarded while we resolved — a checkpoint landing mid-resolve would
  // otherwise leave a permanent stale miss.
  if (chartCacheGeneration === generationAtStart) {
    chartCache.set(cacheK, response);
    while (chartCache.size > CHART_CACHE_MAX) {
      chartCache.delete(chartCache.keys().next().value);
    }
  }
  return response;
}

// ── messages ────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "START_CAPTURE":
      handleStartCapture(message.tabId, message.streamId).then(sendResponse);
      return true;

    case "START_CAPTURE_DISPLAY_MEDIA":
      handleStartCaptureViaDisplayMedia(message.tabId).then(sendResponse);
      return true;

    case "STOP_CAPTURE_REQUEST":
      stopCapture();
      sendResponse({ success: true });
      return false;

    case "FETCH_LYRICS":
      handleFetchLyrics(message).then(sendResponse);
      return true;

    case "FETCH_CHART":
      handleFetchChart(message).then(sendResponse);
      return true;

    // MEDIA_STATE / PLAYBACK_TIME / SONG_CHANGED are deliberately NOT handled
    // here. chrome.runtime.sendMessage from a content script already reaches
    // every extension page — the side panel AND the offscreen document — so
    // relaying them through the SW would deliver each one twice. Both filter by
    // sender.tab.id instead.

    // CHORD_CHART likewise: the offscreen document broadcasts it and the panel
    // receives it directly.

    case "GET_STATE":
      // Awaited: a state request is often the very event that woke an evicted
      // SW, and answering from not-yet-recovered memory would report "off"
      // while audio is still playing.
      captureStateReady.then(() => sendResponse({
        isActive: capturedTabId !== null,
        tabId: capturedTabId,
        settings,
      }));
      return true;

    case "SET_SETTING": {
      const { key, value } = message;
      if (!(key in DEFAULTS)) { sendResponse({ ok: false }); return false; }
      settings[key] = value;
      persistSettings();
      const forward = {
        mode: () => ({ type: "SET_MODE", value }),
        amount: () => ({ type: "SET_AMOUNT", value: clamp01(value / 100) }),
        makeupDb: () => ({ type: "SET_MAKEUP_DB", value }),
        autoGain: () => ({ type: "SET_AUTO_GAIN", value }),
        mono: () => ({ type: "SET_MONO", value }),
        repet: () => ({ type: "SET_REPET", value }),
        chords: () => ({ type: "SET_CHORDS_ENABLED", value }),
      }[key];
      if (forward) chrome.runtime.sendMessage(forward()).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    // The offscreen document writes charts (finalize, REANALYZE-discard) that
    // this cache would otherwise keep contradicting until SW eviction.
    case "CHART_SAVED":
    case "REANALYZE": {
      chartCacheGeneration++;
      const k = message.videoKey;
      if (k) { chartCache.delete(`${k}|0`); chartCache.delete(`${k}|1`); }
      else chartCache.clear();
      return false;
    }

    // From the offscreen document.
    case "DISPLAY_MEDIA_FAILED":
    case "CAPTURE_FAILED":
      setCapturedTab(null, null);
      broadcastState(false);
      return false;

    case "CAPTURE_ACTIVE":
      broadcastState(true);
      return false;
  }
  return false;
});

updateBadge();
