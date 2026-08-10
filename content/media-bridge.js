// Instrufilt — headless media bridge.
//
// Forked from Karafilt's content/lyrics-overlay.js, reduced to the parts that
// are about MEDIA rather than lyrics: find the playing element, publish its
// clock, and report which song it is. It creates no DOM — the side panel is
// the only surface. The lead-sheet phase layers lyric and chord fetching on
// top of exactly this state.
//
// Everything here transfers from Karafilt unchanged in spirit, including the
// less obvious defences: the extension-liveness guard (the runtime dies on
// every extension reload while this script keeps running), the generation
// guard, and foreground-only work.

(() => {
  if (window.__instrufiltBridgeLoaded) return;
  window.__instrufiltBridgeLoaded = true;

  const IF_DEBUG = false;
  const dbg = (...a) => { if (IF_DEBUG) console.log("[if/cs]", ...a); };

  // Vendored verbatim from Karafilt — see vendor/MANIFEST.json for why the
  // Karafilt* names are kept rather than renamed. Alias at the point of use,
  // which is what Karafilt's own service worker does (service-worker.js:7).
  // video-key.js exports a bare function, not a namespace.
  const SM = globalThis.KarafiltSongMatch;
  const deriveVideoKey = globalThis.deriveVideoKey;
  const ADAPTERS = globalThis.KarafiltSiteAdapter;

  const PLAYBACK_TICK_MS = 200;
  const SONG_CHANGE_DEBOUNCE_MS = 400;

  const ADAPTER = ADAPTERS && ADAPTERS.forHost ? ADAPTERS.forHost(location.hostname) : null;
  if (ADAPTER && ADAPTER.init) ADAPTER.init();

  let mediaElement = null;
  let tickerId = null;
  let lastSongKey = "";
  let refreshTimer = null;
  let songInfo = null;

  let lyrics = null;          // the resolved lookup result, or null
  let status = "";
  let lastFetchedKey = null;
  // Bumped on every song change. A lookup that resolves after the song moved
  // on compares its captured generation and drops itself, so a slow response
  // for the previous track can never overwrite the current one.
  let loadGeneration = 0;

  // ── extension liveness ────────────────────────────────────────────────────
  // On every extension reload the runtime is torn down under a content script
  // that keeps running. Without this guard each tick throws
  // "Extension context invalidated" into the page console forever.
  function isExtensionValid() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  function send(msg) {
    if (!isExtensionValid()) return;
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(() => {});
    } catch {
      // Receiving end absent (panel closed, SW asleep) — not an error.
    }
  }

  // ── media detection ───────────────────────────────────────────────────────

  function findMedia() {
    // Adapter sites expose playback as a virtual element: Spotify's real
    // <audio> is never attached to the DOM, so querySelectorAll finds nothing.
    if (ADAPTER) {
      const vm = ADAPTER.getVirtualMedia();
      if (vm) return vm;
    }
    const all = Array.from(document.querySelectorAll("video, audio"));
    if (all.length === 0) return null;
    return all.find((m) => !m.paused && m.currentTime > 0) || all[0];
  }

  // Still usable if it is the adapter's virtual element, or a DOM node the
  // page has not torn down underneath us.
  function isLiveMedia(m) {
    return !!(m && (m.isVirtual || document.contains(m)));
  }

  // ── song identity ─────────────────────────────────────────────────────────

  // YouTube metadata, best source first. schema.org is authoritative on
  // verified music videos; ytInitialPlayerResponse is next; DOM selectors last.
  function youtubeHint() {
    try {
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        const data = JSON.parse(el.textContent || "{}");
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) {
          if (it && /MusicVideoObject|MusicRecording/.test(it["@type"] || "")) {
            return {
              metaTrack: it.name || "",
              metaArtist: (it.byArtist && it.byArtist.name) || "",
              author: channelName(),
            };
          }
        }
      }
    } catch {}
    return { metaTrack: "", metaArtist: "", author: channelName() };
  }

  function channelName() {
    const sels = [
      "ytd-video-owner-renderer ytd-channel-name a",
      "ytd-channel-name a.yt-formatted-string",
      "#owner-name a",
      "#channel-name a",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      // "- Topic" channels are auto-generated per artist; the suffix is noise.
      if (el && el.textContent) return el.textContent.trim().replace(/\s*-\s*Topic\s*$/i, "");
    }
    return "";
  }

  function identifySong() {
    const raw = document.title;
    const isYT = /(^|\.)youtube\.com$/.test(location.hostname);
    const hint = ADAPTER && ADAPTER.getSongHint ? ADAPTER.getSongHint() : (isYT ? youtubeHint() : null);
    const candidates = (SM && SM.parseTitle) ? SM.parseTitle(raw, hint || undefined) : [];
    const best = candidates && candidates[0];
    return {
      rawTitle: raw,
      cleanedTitle: SM && SM.cleanTitle ? SM.cleanTitle(raw) : raw,
      artist: (best && best.artist) || "",
      track: (best && best.track) || "",
      videoKey: videoKey(),
    };
  }

  // Is an ad playing right now?
  //
    // Deliberately here rather than in the vendored site-adapters.js. That file
  // returns null for YouTube (the generic pipeline handles it), so there is no
  // YouTube adapter to extend — and editing a vendored file in place is exactly
  // what vendor/MANIFEST.json forbids.
  //
  // The chord accumulator needs this badly: an ad is not silence, it is
  // confidently harmonic audio belonging to a different piece of music, and
  // analysing it writes plausible-looking nonsense into the chart for a song
  // that was not playing.
  function detectAd() {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return false;
    const player = document.querySelector("#movie_player");
    if (player && player.classList.contains("ad-showing")) return true;
    return !!document.querySelector(".ytp-ad-player-overlay, .ytp-ad-module .ytp-ad-text");
  }

  function videoKey() {
    // The adapter wins where the URL is unreliable: on Spotify you can browse
    // one page while a different track plays.
    if (ADAPTER && ADAPTER.getVideoKey) {
      const k = ADAPTER.getVideoKey();
      if (k) return k;
    }
    return deriveVideoKey ? deriveVideoKey(location.href) : null;
  }

  // ── publishing ────────────────────────────────────────────────────────────

  function publishState() {
    send({
      type: "MEDIA_STATE",
      state: {
        ...songInfo,
        hasMedia: !!findMedia(),
        statusHint: (ADAPTER && ADAPTER.getStatusHint && ADAPTER.getStatusHint()) || "",
        isAd: detectAd(),
        status,
        lyrics,
      },
    });
  }

  function setStatus(s) {
    status = s || "";
    publishState();
  }

  // ── lyrics lookup ─────────────────────────────────────────────────────────
  //
  // Two phases, so a miss does not cost the user thirty seconds.
  //
  //   Phase 1  the top 3 title-parse candidates, Karalyr only (exact lookups,
  //            fast), fired in PARALLEL but resolved in CANDIDATE-PRIORITY
  //            order. That ordering is the important part — see settle().
  //   Phase 2  only if phase 1 missed: one full lookup (Karalyr + LRCLib's
  //            broad search) on the single cleanest candidate.

  function requestLyrics(cand, opts) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          type: "FETCH_LYRICS",
          artist: cand.artist,
          track: cand.track,
          album: cand.album || "",
          durationSec: (opts && opts.durationSec) || 0,
          videoKey: (opts && opts.videoKey) || null,
          karalyrOnly: !!(opts && opts.karalyrOnly),
          forceRefresh: !!(opts && opts.forceRefresh),
        }, (res) => {
          void chrome.runtime.lastError;   // SW asleep or extension reloaded
          resolve(res || { found: false });
        });
      } catch {
        resolve({ found: false });
      }
    });
  }

  const isSynced = (r) => !!(r && r.found && r.syncedLyrics);
  // Identity came from the video id, not from parsing a title, so it cannot be
  // the wrong song — it may resolve immediately without waiting its turn.
  const isById = (r) => !!(r && r.matchedBy === "video-id");

  async function loadLyrics(opts) {
    const media = findMedia();
    const durationSec = media && isFinite(media.duration) ? media.duration : 0;
    const videoKey = songInfo && songInfo.videoKey;

    const hint = ADAPTER && ADAPTER.getSongHint ? ADAPTER.getSongHint()
      : (/(^|\.)youtube\.com$/.test(location.hostname) ? youtubeHint() : null);
    const candidates = (SM && SM.parseTitle)
      ? SM.parseTitle(document.title, hint || undefined).slice(0, 3)
      : [];
    if (candidates.length === 0) { setStatus("Couldn't read the song title"); return; }

    const gen = ++loadGeneration;
    const stale = () => gen !== loadGeneration;

    setStatus("Looking for lyrics…");

    // ── phase 1 ──
    const results = new Array(candidates.length).fill(undefined);
    let settled = false;

    await new Promise((done) => {
      // Resolve in candidate-priority order, not first-response order. The
      // candidates are already sorted most-trusted first, so a fast weak match
      // on candidate 3 must not beat a slower strong match on candidate 1 that
      // is still on the wire. Karafilt shipped first-response-wins and it
      // produced real wrong-song bugs.
      const settle = () => {
        if (settled) return;
        let bestPlain = null;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r === undefined) return;              // an earlier candidate is still pending
          if (r && r.found) {
            if (isSynced(r)) { settled = true; commit(r, gen); done(); return; }
            if (!bestPlain) bestPlain = r;
          }
        }
        settled = true;
        if (bestPlain) commit(bestPlain, gen);
        done();
      };

      candidates.forEach((c, i) => {
        requestLyrics(c, { durationSec, videoKey, karalyrOnly: true, forceRefresh: opts && opts.forceRefresh })
          .then((r) => {
            if (stale()) { done(); return; }
            // The one exception to priority order: a by-id hit is identified by
            // the video itself, so no earlier candidate can outrank it.
            if (isById(r) && isSynced(r)) { settled = true; commit(r, gen); done(); return; }
            results[i] = r;
            settle();
          });
      });
    });

    if (stale() || (lyrics && lyrics.found && lyrics.syncedLyrics)) return;

    // ── phase 2 ──
    // The cleanest candidate only: an artist with no comma in it is the one
    // least likely to be a mis-parse, and a broad search is expensive.
    const fallback = candidates.find((c) => c.artist && !c.artist.includes(",")) || candidates[0];
    const full = await requestLyrics(fallback, { durationSec, videoKey, forceRefresh: opts && opts.forceRefresh });
    if (stale()) return;
    if (full && full.found) commit(full, gen);
    else if (!lyrics) setStatus("No lyrics found for this song");
  }

  function commit(result, gen) {
    if (gen !== loadGeneration) return;   // a newer song already won
    lyrics = result;
    status = "";
    publishState();
  }

  function publishPlaybackTime() {
    const media = isLiveMedia(mediaElement) ? mediaElement : findMedia();
    const appeared = !mediaElement && !!media;
    mediaElement = media;
    if (!media || !isExtensionValid()) return;
    // The media element often shows up after document_idle, so the boot-time
    // lookup can fire before there is anything to look up. Retry on arrival.
    if (appeared) maybeLoadLyrics();
    send({
      type: "PLAYBACK_TIME",
      time: media.currentTime,
      duration: isFinite(media.duration) ? media.duration : 0,
      paused: media.paused,
      videoKey: songInfo && songInfo.videoKey,
    });
  }

  let lastAd = false;
  function startTicker() {
    if (tickerId != null) return;
    tickerId = setInterval(() => {
      publishPlaybackTime();
      // An ad boundary fires none of the song-change signals, and the chord
      // accumulator must stop within a tick rather than at the next song.
      const ad = detectAd();
      if (ad !== lastAd) { lastAd = ad; publishState(); }
    }, PLAYBACK_TICK_MS);
  }

  function stopTicker() {
    if (tickerId != null) { clearInterval(tickerId); tickerId = null; }
  }

  // ── song-change detection ─────────────────────────────────────────────────
  // Three independent signals can announce a new song: SPA navigation, a
  // <title> change, and a media element firing loadstart. Each routes through
  // maybeRefresh, debounced so signals from one navigation coalesce into a
  // single pass, then gated on a composite key so a repeated signal with an
  // unchanged key costs nothing.

  function getSongKey() {
    if (ADAPTER && ADAPTER.getSongKey) {
      const k = ADAPTER.getSongKey();
      if (k) return k;
    }
    const cleaned = SM && SM.cleanTitle ? SM.cleanTitle(document.title) : document.title;
    return location.pathname + location.search + "|" + cleaned;
  }

  function performRefresh(reason) {
    refreshTimer = null;
    const key = getSongKey();
    if (key === lastSongKey) return;
    lastSongKey = key;
    dbg("song change via", reason, "->", key);

    mediaElement = null;
    lyrics = null;
    status = "";
    lastFetchedKey = null;
    loadGeneration++;                     // orphan any lookup still in flight
    songInfo = identifySong();
    send({ type: "SONG_CHANGED", videoKey: songInfo.videoKey });
    publishState();
    maybeLoadLyrics();
  }

  // On YouTube only watch pages are songs; search, home and channel pages
  // clear stale state but must not fire a lookup.
  function isYouTubeWatchPage() {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return true;
    return location.pathname === "/watch" || location.pathname.startsWith("/shorts/");
  }

  function maybeLoadLyrics(opts) {
    // Background tabs share the request queue with the foreground one, and a
    // tab the user cannot see has nothing to display anyway.
    if (document.visibilityState !== "visible") return;
    if (!isYouTubeWatchPage()) return;
    if (ADAPTER && ADAPTER.shouldFetch && !ADAPTER.shouldFetch()) return;
    if (!findMedia()) return;

    const key = getSongKey();
    if (!(opts && opts.forceRefresh) && key === lastFetchedKey) return;
    lastFetchedKey = key;
    loadLyrics(opts);
  }

  function maybeRefresh(reason) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => performRefresh(reason), SONG_CHANGE_DEBOUNCE_MS);
  }

  // SPA navigation. History methods are patched because pushState fires no
  // event of its own, and YouTube navigates almost entirely through it.
  (function patchHistory() {
    const fire = () => window.dispatchEvent(new Event("if-locationchange"));
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    }
    window.addEventListener("popstate", fire);
  })();

  window.addEventListener("if-locationchange", () => maybeRefresh("navigation"));

  if (document.querySelector("title")) {
    new MutationObserver(() => maybeRefresh("title")).observe(
      document.querySelector("title"),
      { childList: true, characterData: true, subtree: true }
    );
  }

  // Capturing, because loadstart does not bubble.
  document.addEventListener("loadstart", (e) => {
    const t = e.target;
    if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) maybeRefresh("loadstart");
  }, true);

  if (ADAPTER && ADAPTER.watchSongChanges) {
    ADAPTER.watchSongChanges(() => maybeRefresh("adapter"));
  }

  // ── messages ──────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_MEDIA_STATE") {
      if (!songInfo) songInfo = identifySong();
      sendResponse({
        ...songInfo,
        hasMedia: !!findMedia(),
        statusHint: (ADAPTER && ADAPTER.getStatusHint && ADAPTER.getStatusHint()) || "",
        isAd: detectAd(),
        status,
        lyrics,
      });
      // A panel opened mid-song asks for state before anything triggered a
      // lookup, so this is also the cue to start one.
      maybeLoadLyrics();
      return false;
    }
    if (message.type === "SEEK_TO") {
      const media = isLiveMedia(mediaElement) ? mediaElement : findMedia();
      if (media) { try { media.currentTime = message.time; } catch {} }
      return false;
    }
    if (message.type === "REFRESH_LYRICS") {
      lyrics = null;
      setStatus("Looking for lyrics…");
      maybeLoadLyrics({ forceRefresh: true });
      return false;
    }
    return false;
  });

  // ── start ─────────────────────────────────────────────────────────────────

  songInfo = identifySong();
  lastSongKey = getSongKey();
  startTicker();
  publishState();
  maybeLoadLyrics();

  // Background tabs neither need nor deserve a ticker; re-identify on return
  // in case the song changed while we were away, and pick up any lookup that
  // was skipped because the tab was hidden.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startTicker();
      maybeRefresh("visible");
      maybeLoadLyrics();
    } else {
      stopTicker();
    }
  });
})();
