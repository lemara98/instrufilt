// Instrufilt account surfaces: the sign-in gate, the footer account chip, and
// the per-song vote row.
//
// Ported from Karafilt's model (shared/controls-bindings.js + sidepanel.js
// there), but kept OUT of sidepanel.js here: this module owns everything that
// depends on the instrufilt.com session, and the panel proper never has to
// know whether accounts exist. It listens to the same broadcasts the panel
// does (content scripts broadcast to every extension page) and keeps its own
// tiny copy of song/capture state instead of reaching into the panel's
// closure.
//
// One account works across the family: instrufilt.com shares its Supabase
// project with karafilt.com, so an existing Karafilt account signs straight
// in. The extension itself never sees a token — sign-in state IS the site
// cookie, probed via GET_ACCOUNT_STATUS (see the service worker).

(() => {
  "use strict";

  const els = {
    gate: document.getElementById("auth-gate"),
    gateSignIn: document.getElementById("auth-gate-signin"),
    chip: document.getElementById("account-chip"),
    chipAvatar: document.getElementById("account-avatar"),
    chipEmail: document.getElementById("account-email"),
    voteRow: document.getElementById("vote-row"),
    voteLike: document.getElementById("vote-like"),
    voteDislike: document.getElementById("vote-dislike"),
    voteLikeCount: document.getElementById("vote-like-count"),
    voteDislikeCount: document.getElementById("vote-dislike-count"),
  };

  let signedIn = false;
  let loginUrl = null;      // filled from the probe (respects websiteUrl override)
  let accountUrl = null;
  let pinnedTabId = null;
  let isActive = false;
  let mode = null;
  let videoKey = null;
  let song = { songTitle: null, trackName: null, artistName: null };
  let videoUrl = null;
  let myVote = null;        // "like" | "dislike" | null
  let voteBusy = false;

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

  // ── sign-in gate + chip ───────────────────────────────────────────────────

  function applyAccountUI() {
    // The gate covers the whole panel; everything under it stays inert.
    els.gate.hidden = signedIn;
    if (signedIn && accountUrl) {
      els.chip.hidden = false;
      els.chip.href = accountUrl;
      const email = els.chipEmail.textContent || "";
      els.chipAvatar.textContent = (email[0] || "?").toUpperCase();
    } else {
      els.chip.hidden = true;
    }
    renderVoteRow();
  }

  async function refreshAccountStatus() {
    const acc = await sendMessage({ type: "GET_ACCOUNT_STATUS" });
    // `disabled` (no Website URL configured) shouldn't happen with the default
    // site, but if it does, don't lock the user out.
    signedIn = !acc || acc.disabled ? true : !!acc.signedIn;
    if (acc && acc.loginUrl) loginUrl = acc.loginUrl;
    if (acc && acc.accountUrl) accountUrl = acc.accountUrl;
    els.chipEmail.textContent = (acc && acc.email) || "";
    applyAccountUI();
    if (signedIn) refreshMyVote();
  }

  els.gateSignIn.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "OPEN_LOGIN",
      loginUrl,
      returnTabId: pinnedTabId,
    }).catch(() => {});
  });

  // ── vote row ("How did it sound?") ────────────────────────────────────────

  function renderVoteRow() {
    // Voting needs a signed-in session, a song identity, and something to
    // judge — show it while isolating, and keep it while the song lasts once
    // a vote exists (so the user can change their mind after stopping).
    const show = signedIn && !!videoKey && (isActive || !!myVote);
    els.voteRow.hidden = !show;
    if (!show) return;
    els.voteLike.classList.toggle("is-selected", myVote === "like");
    els.voteDislike.classList.toggle("is-selected", myVote === "dislike");
  }

  function resetVoteState() {
    myVote = null;
    els.voteLikeCount.textContent = "";
    els.voteDislikeCount.textContent = "";
    renderVoteRow();
  }

  async function refreshMyVote() {
    if (!signedIn || !videoKey) return;
    const requestedKey = videoKey;
    const mine = await sendMessage({ type: "GET_MY_FILTER_RATING", videoKey: requestedKey });
    if (requestedKey !== videoKey) return; // song changed while we asked
    if (mine && mine.ok && mine.liked !== null && mine.liked !== undefined) {
      myVote = mine.liked ? "like" : "dislike";
    }
    renderVoteRow();
    refreshVoteStats();
  }

  async function refreshVoteStats() {
    if (!videoKey) return;
    const requestedKey = videoKey;
    const res = await sendMessage({ type: "GET_FILTER_RATING_STATS", videoKeys: [requestedKey] });
    if (requestedKey !== videoKey) return;
    const s = res && res.ok && res.stats ? res.stats[requestedKey] : null;
    els.voteLikeCount.textContent = s && s.likes ? String(s.likes) : "";
    els.voteDislikeCount.textContent = s && s.dislikes ? String(s.dislikes) : "";
  }

  async function castVote(vote) {
    if (voteBusy || !signedIn || !videoKey) return;
    voteBusy = true;
    const prior = myVote;
    myVote = vote;            // optimistic — the row answers immediately
    renderVoteRow();
    const res = await sendMessage({
      type: "SUBMIT_FILTER_RATING",
      rating: {
        vote,
        videoKey,
        videoUrl,
        songTitle: song.songTitle,
        trackName: song.trackName,
        artistName: song.artistName,
        filterMode: mode,
        extensionVersion: chrome.runtime.getManifest().version,
      },
    });
    if (!res || !res.ok) {
      myVote = prior;         // roll back; a 401 also re-probes the session
      renderVoteRow();
      if (res && res.status === 401) refreshAccountStatus();
    } else {
      refreshVoteStats();
    }
    voteBusy = false;
  }

  els.voteLike.addEventListener("click", () => castVote("like"));
  els.voteDislike.addEventListener("click", () => castVote("dislike"));

  // ── broadcasts ────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender) => {
    // Same pinning rule as the panel: content-script broadcasts from a tab we
    // are not attached to are not ours.
    if (sender && sender.tab && pinnedTabId != null && sender.tab.id !== pinnedTabId) return;

    switch (message.type) {
      case "ACCOUNT_CHANGED":
        refreshAccountStatus();
        break;
      case "CAPTURE_STATE":
        isActive = !!message.isActive;
        if (message.settings && message.settings.mode) mode = message.settings.mode;
        renderVoteRow();
        break;
      case "CAPTURE_ACTIVE":
        isActive = true;
        renderVoteRow();
        break;
      case "MEDIA_STATE": {
        const st = message.state;
        if (!st) break;
        song = {
          songTitle: st.cleanedTitle || null,
          trackName: st.track || null,
          artistName: st.artist || null,
        };
        if (st.videoKey && st.videoKey !== videoKey) {
          videoKey = st.videoKey;
          resetVoteState();
          if (signedIn) refreshMyVote();
        }
        break;
      }
      case "SONG_CHANGED":
        if (message.videoKey !== videoKey) {
          videoKey = message.videoKey || null;
          resetVoteState();
          if (signedIn) refreshMyVote();
        }
        break;
    }
  });

  // The user may sign in or out on the website while the panel is open.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAccountStatus();
  });

  // ── boot ──────────────────────────────────────────────────────────────────

  (async function init() {
    try {
      const { boundTabId } = await chrome.storage.session.get({ boundTabId: null });
      pinnedTabId = boundTabId;
    } catch {}

    const state = await sendMessage({ type: "GET_STATE" });
    if (state) {
      isActive = !!state.isActive;
      if (state.settings && state.settings.mode) mode = state.settings.mode;
      if (state.tabId != null) pinnedTabId = state.tabId;
    }

    if (pinnedTabId != null) {
      try {
        const tab = await chrome.tabs.get(pinnedTabId);
        videoUrl = tab && tab.url ? tab.url : null;
      } catch {}
      chrome.tabs.sendMessage(pinnedTabId, { type: "GET_MEDIA_STATE" }, (res) => {
        void chrome.runtime.lastError; // no content script on this page
        if (res && res.videoKey) {
          videoKey = res.videoKey;
          song = {
            songTitle: res.cleanedTitle || null,
            trackName: res.track || null,
            artistName: res.artist || null,
          };
          if (signedIn) refreshMyVote();
        }
      });
    }

    refreshAccountStatus();
  })();
})();
