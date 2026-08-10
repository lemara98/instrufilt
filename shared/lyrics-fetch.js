// Lyrics lookup — Karalyr, then LRCLib.
//
// Loaded by the service worker via importScripts(). The SW is the only place
// this can live: host_permissions let it fetch cross-origin without CORS,
// and it keeps running when the panel is closed.
//
// Two sources, not Karafilt's four. Karafilt also falls back to Lyrics.ovh and
// a Genius HTML scrape; both are dropped here. They return PLAIN lyrics only,
// and plain lyrics cannot place a chord — the lead sheet needs line timing at
// minimum and word timing to be exact. A scraper is also the kind of thing that
// draws Web Store review attention, and it would buy Instrufilt nothing.
//
// Karalyr is tried first for the same reason it is in Karafilt: it serves
// word-synced lyrics, which is precisely what LRCLib does not have.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltLyricsFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SM = () => globalThis.KarafiltSongMatch;

  const DEFAULT_KARALYR_BASE = "https://www.karalyr.com";
  const KARALYR_TIMEOUT_MS = 1500;   // a dead server must fail fast, not stall the chain
  const LRCLIB_TIMEOUT_MS = 5000;

  let karalyrBase = DEFAULT_KARALYR_BASE;
  function setKaralyrBase(base) {
    karalyrBase = base || DEFAULT_KARALYR_BASE;
  }

  // ── fetch with a deadline ───────────────────────────────────────────────
  // Without this a hung upstream blocks until the browser's socket timeout
  // (30-120s). An aborted fetch throws; every call site treats that as a miss.
  async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── LRCLib throttle ─────────────────────────────────────────────────────
  // One lookup fans out several requests per candidate, across up to three
  // candidates. Browsers cap ~6 connections per host, so the overflow queues
  // *in the browser* — with each request's abort timer already running. The
  // queued ones then time out before they are ever sent. Two fixes, both from
  // Karafilt, which hit exactly this: cap our own concurrency so a timer only
  // starts once a slot is free, and dedupe identical in-flight URLs.
  const MAX_CONCURRENT = 5;   // stay under the browser's ~6/host
  const MAX_QUEUE = 16;
  let active = 0;
  const waiters = [];
  const inflight = new Map();

  function acquire() {
    if (active < MAX_CONCURRENT) { active++; return Promise.resolve(true); }
    return new Promise((resolve) => {
      waiters.push(resolve);
      // Evict the OLDEST waiter — the stalest, usually a song the user has
      // already skipped past — so a backlog cannot starve the current lookup.
      while (waiters.length > MAX_QUEUE) waiters.shift()(false);
    });
  }

  function release() {
    const next = waiters.shift();
    if (next) next(true);   // hand the slot straight over
    else active--;
  }

  function throttledJson(url, timeoutMs) {
    const existing = inflight.get(url);
    if (existing) return existing;
    const p = (async () => {
      if (!(await acquire())) return null;   // evicted as stale
      try {
        const r = await fetchWithTimeout(url, timeoutMs);
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      } finally {
        release();
      }
    })();
    inflight.set(url, p);
    p.finally(() => inflight.delete(url));
    return p;
  }

  // ── Karalyr ─────────────────────────────────────────────────────────────

  async function karalyrJson(path, params) {
    const u = new URL(path, karalyrBase);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    try {
      const res = await fetchWithTimeout(u.toString(), KARALYR_TIMEOUT_MS);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  function fromKaralyrRow(row, matchedBy) {
    if (!row) return null;
    const synced = row.syncedLyrics || null;
    const plain = row.plainLyrics || null;
    if (!synced && !plain) return null;
    return {
      found: true,
      syncedLyrics: synced,
      plainLyrics: plain,
      trackName: row.trackName || "",
      artistName: row.artistName || "",
      source: "karalyr",
      matchedBy,
      wordTimed: !!(row.karalyr && row.karalyr.has_word_timing),
      matchScore: matchedBy === "video-id" ? -1000 : 0,   // an id match outranks everything
      matchSynced: !!synced,
      alternatives: [],
    };
  }

  async function fetchFromKaralyr({ artist, track, album, durationSec, videoKey }) {
    // The by-id lookup needs no parsed name at all, so only bail when there is
    // neither an id nor a usable {artist, track}.
    if (!karalyrBase || (!videoKey && (!artist || !track))) return { found: false };

    // Identity from the video id, not from parsing a title — this is the one
    // lookup that cannot be wrong about which song is playing.
    if (videoKey) {
      const params = videoKey.startsWith("yt:") ? { youtube_id: videoKey.slice(3) }
        : videoKey.startsWith("sp:") ? { spotify_id: videoKey.slice(3) }
        : { video_key: videoKey };
      const hit = fromKaralyrRow(await karalyrJson("/api/get", params), "video-id");
      if (hit) return hit;
    }

    if (!artist || !track) return { found: false };

    const byName = { artist_name: artist, track_name: track };
    if (album) byName.album_name = album;
    // duration is deliberately omitted: on /api/get it is an exact ±2s filter,
    // so passing a VIDEO length 404s whenever it differs from the stored audio
    // length (intros, ads, re-masters). It is folded back in via scoring.
    const named = fromKaralyrRow(await karalyrJson("/api/get", byName), "name");
    if (named) return named;

    // FTS search catches rows whose STORED identity differs from the parsed one
    // — e.g. an aligned import saved under a channel name plus the raw video
    // title. Search rows carry no lyrics, so the winner is re-fetched by its
    // own exact identity.
    const rows = await karalyrJson("/api/search", { q: `${track} ${artist}` });
    if (!Array.isArray(rows) || rows.length === 0) return { found: false };

    const M = SM();
    const want = { track, artist, durationSec };
    const usable = rows.filter(
      (r) => r && r.karalyr && r.karalyr.has_lyrics &&
        (M.accept(r, want) || M.identityCovers(r.artistName, r.trackName, want))
    );
    if (!usable.length) return { found: false };
    usable.sort((a, b) => M.scoreRow(a, want) - M.scoreRow(b, want));
    const hit = usable[0];

    const exact = { artist_name: hit.artistName, track_name: hit.trackName };
    if (hit.albumName) exact.album_name = hit.albumName;
    return fromKaralyrRow(await karalyrJson("/api/get", exact), "name") || { found: false };
  }

  // ── LRCLib ──────────────────────────────────────────────────────────────

  async function fetchFromLrclib({ artist, track, album, durationSec }) {
    if (!track) return { found: false };
    const M = SM();

    const reqs = M.buildLrclibRequests({ artist, track, album, durationSec });
    const responses = await Promise.all(
      reqs.map((req) => throttledJson(req.url, req.timeout || LRCLIB_TIMEOUT_MS))
    );

    // /api/get returns one object, /api/search an array.
    const rows = [];
    for (const resp of responses) {
      if (!resp) continue;
      if (Array.isArray(resp)) rows.push(...resp);
      else rows.push(resp);
    }
    if (!rows.length) return { found: false };

    // Artist-aware gate, then synced-first, then track + artist + duration
    // distance. Scoring runs BEFORE dedup so a synced copy beats an
    // identically-named plain one.
    const picked = M.pickBest(rows, { track, artist, durationSec });
    if (!picked) return { found: false };

    return {
      found: true,
      syncedLyrics: picked.best.syncedLyrics || null,
      plainLyrics: picked.best.plainLyrics || null,
      trackName: picked.best.trackName,
      artistName: picked.best.artistName,
      source: "lrclib",
      matchScore: picked.score,
      matchSynced: picked.synced,
      alternatives: (picked.alternatives || []).slice(0, 5).map((r) => ({
        trackName: r.trackName,
        artistName: r.artistName,
        syncedLyrics: r.syncedLyrics || null,
        plainLyrics: r.plainLyrics || null,
        source: "lrclib",
      })),
    };
  }

  // ── the chain ───────────────────────────────────────────────────────────

  /**
   * @param {{artist,track,album,durationSec,videoKey}} q
   * @param {{karalyrOnly?:boolean}} opts  karalyrOnly skips LRCLib — used by
   *        phase 1 of the caller's fan-out, so the cheap exact lookups run
   *        across every candidate before any broad search does.
   */
  async function lookup(q, opts) {
    const karalyr = await fetchFromKaralyr(q);
    // Only a SYNCED Karalyr hit short-circuits. A plain-lyrics hit still lets
    // LRCLib run, because LRCLib may have a synced copy — and for a lead sheet
    // timing is the whole point.
    if (karalyr.found && karalyr.syncedLyrics) return karalyr;
    if (opts && opts.karalyrOnly) return karalyr;

    const lrclib = await fetchFromLrclib(q);
    if (lrclib.found && lrclib.syncedLyrics) return lrclib;
    // Neither is synced — prefer whichever exists, Karalyr first.
    if (karalyr.found) return karalyr;
    return lrclib;
  }

  return {
    lookup,
    fetchFromKaralyr,
    fetchFromLrclib,
    setKaralyrBase,
    fetchWithTimeout,
    DEFAULT_KARALYR_BASE,
  };
});
