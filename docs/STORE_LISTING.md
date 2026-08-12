# Chrome Web Store listing — copy & submission answers

Everything to paste into the CWS developer dashboard. Build the zip with
`scripts/package.sh` (output: `dist/instrufilt-<version>.zip`).

Submission checklist:
- [ ] Upload `dist/instrufilt-1.0.0.zip`
- [ ] 3–5 screenshots, exactly 1280×800 — see `store-assets/`
- [ ] Small promo tile 440×280 — `store-assets/promo-tile-440x280.png`
- [ ] Marquee 1400×560 (optional, needed for feature placement) — `store-assets/marquee-1400x560.png`
- [ ] Privacy policy live at `https://www.instrufilt.com/privacy` (deployed)
- [ ] **Reviewer test account**: the extension requires sign-in, so provide
      working test credentials in the dashboard's "Account required" /
      reviewer-notes field, or Google cannot review past the login gate.
      An existing Karafilt account works (shared accounts) — but create a
      dedicated `cws-review@…` test user rather than handing over a real one.
- [ ] After publication: set `CHROME_EXTENSION_ID` in the instrufilt-website
      Vercel project so /install flips from "coming soon" to the store link.

---

## Store listing

**Name:** Instrufilt

**Summary** (132 chars max):

> Practice your instrument along to any song: mute the band, keep the singer,
> and read time-synced chords over the lyrics.

**Category:** Entertainment

**Language:** English

**Detailed description:**

> Turn any tab into a practice session. Instrufilt keeps the lead vocal of the
> song you're playing — YouTube, streaming sites, anywhere music plays — and
> mutes the band in real time, so YOU play the accompaniment. The side panel
> shows a lead sheet: the song's chords laid over time-synced lyrics. Free.
>
> **How it works**
> Sign in with your free account, then click the Instrufilt icon on a tab
> playing music — the side panel opens with the song's lead sheet, pinned to
> that tab so the rest of your browsing is untouched. Press Start isolating
> (or Alt+Shift+I) and the band steps back.
>
> **Features**
> • Real-time isolation — runs entirely in your browser (WebAssembly), no
>   uploads, no waiting
> • Three modes: Vocal + rhythm (singer plus kick, bass and snare — keeps a
>   groove to lock to), Vocal only (cleanest reference), and Lead line (for
>   picking a melody out by ear)
> • A real lead sheet: chords positioned over time-synced lyrics, with a big
>   now/next chord strip you can read from a meter away
> • Chord fingering diagrams for the current and next chord
> • Transpose with one tap — play in your key, nothing re-analyzes
> • Chords from three sources: ready-made charts from Karalyr (our own
>   community database) and Songle (AIST's music-understanding service), plus
>   on-device chord detection that works on any song, fully offline
> • Isolation amount slider — dial the band back in as a guide when learning
> • "How to play" and tab search shortcuts for the current song
> • Practice stats and badges: your practice time per song and mode on your
>   account page, from Sound Check (1 hour) to Virtuoso (100 hours)
> • Vote 👍/👎 on how well isolation worked on each song
> • Works on any site that plays audio
>
> **Free, with an account**
> Instrufilt is completely free. You sign in once with a free account — the
> same account works for our sibling extension Karafilt — and you can delete
> it at any time from instrufilt.com.
>
> **Privacy**
> Isolation happens 100% locally — your audio never leaves the browser. Song
> titles are sent to lyrics and chord databases to find the matching lead
> sheet.
>
> Privacy policy: https://www.instrufilt.com/privacy

---

## Privacy tab

**Single purpose description:**

> Instrufilt isolates the lead vocal of the current tab's audio in real time
> (muting the accompaniment) so musicians can play along, and displays the
> song's chords over synchronized lyrics in the side panel.

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `tabCapture` | Core function: captures the current tab's audio so the accompaniment can be muted in real time. Capture starts only on explicit user action (toolbar click, keyboard shortcut, or context-menu item) and stops when the user stops it or leaves the page. |
| `offscreen` | MV3 service workers cannot run the Web Audio API. The offscreen document hosts the audio processing graph (WebAssembly worklet) that isolates the captured tab audio. |
| `activeTab` | Grants the temporary right to capture the tab the user invoked Instrufilt on, preserving the user-gesture requirement of tabCapture without prompting a screen picker. |
| `tabs` | Used to detect when the captured tab navigates to another page (capture is stopped) and to address the active tab when the user starts isolating from the side panel. |
| `storage` | Stores user settings (isolation mode, amount, output level, chord options, instrument) and a small per-device cache of chord charts so a song's chart loads instantly on replay. |
| `sidePanel` | The side panel is the main UI: the lead sheet (chords over synced lyrics), isolation controls, and settings. |
| `scripting` | Injects the media-detection content script into tabs that were already open when the extension was installed or re-enabled, so the lead sheet works without reloading those tabs. |
| `contextMenus` | Adds an "Isolate vocals on this tab" right-click item as an alternative way to start with a clean user gesture. |
| `alarms` | Runs a periodic (60-second) heartbeat only while isolation is active, so the duration of each practice session is timed accurately for the user's own practice stats and is still saved if the MV3 service worker is suspended mid-song. No alarms run when isolation is off. |
| Host permission `<all_urls>` | Instrufilt works on any website that plays audio (YouTube, streaming services, web radios…). The content script reads the page's media title and playback position to find and synchronize the lead sheet for whatever the user is listening to; the user chooses when isolation starts. It also reads the user's instrufilt.com sign-in session to confirm the account is signed in. |

**Remote code:** No, I am not using remote code. All code, including the
WebAssembly DSP module, is bundled in the package. The extension only makes
data requests over the network (lyrics text, chord-chart data, and a sign-in
check against instrufilt.com) — no code is fetched or executed.

**Data usage — what the extension collects:**

- ✅ **Website content** — the page/media title and playback position of the
  tab, sent to lyrics and chord services (karalyr.com, lrclib.net,
  widget.songle.jp) solely to find the matching lead sheet. The tab's audio is
  processed locally and is never transmitted anywhere.
- ✅ **Authentication information** — Instrufilt requires a free account. The
  extension reads your existing instrufilt.com sign-in session (cookie) to
  confirm you are signed in and to show your account email in the side panel.
  It never handles your password — sign-in happens on instrufilt.com — and it
  does not transmit your session anywhere except back to instrufilt.com itself.
- ✅ **User activity** — while you are signed in and actively isolating,
  Instrufilt records which song you practiced (its title and a normalized
  per-song key derived from the tab URL), the isolation mode, and how long
  isolation was active. This is sent to instrufilt.com to power your own
  practice stats (total time, songs, badges) on your account page. If you vote
  on how well isolation worked on a song (a like/dislike), that vote is stored
  as ratings data with the same song info; only aggregate like/dislike counts
  are ever shown publicly. Only songs you actively isolate are recorded —
  general browsing is not — and no audio is ever transmitted.
- ❌ Personally identifiable information (beyond the account email above),
  health, financial, personal communications, location, web history — not
  collected.

**Certifications (tick all three):**
- Not sold to third parties, outside of approved use cases
- Not used or transferred for purposes unrelated to the item's core functionality
- Not used or transferred to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://www.instrufilt.com/privacy`

---

## Distribution

- **Visibility:** Public
- **Pricing:** Free (no in-store or external payments)
- **Regions:** All regions

---

## Notes

- **Songle**: chord charts may come from Songle (AIST, widget.songle.jp),
  used under their non-commercial terms with a permanent on-screen credit and
  no redistribution. A permission request to songle-ml@aist.go.jp is pending;
  if AIST declines, remove the Songle provider (shared/chord-source.js chain +
  the widget.songle.jp CSP entry) or unpublish, per the 2026-08-12 decision.
- The store rejects an update whose manifest `"version"` is not higher than
  the published one. This build is `1.0.0`.
