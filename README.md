# Instrufilt

**Isolate the lead vocal in any browser tab and follow a synced chord chart — practise your instrument against the original singer.**

Instrufilt is the inverse of [Karafilt](https://karafilt.com). Karafilt removes the vocal so you can sing. Instrufilt keeps the vocal and suppresses the band, so you can play.

Everything runs on your machine. No audio ever leaves the browser.

---

## What it does

- **Vocal isolation** — real-time STFT separation in an AudioWorklet (C → WebAssembly), on two independent estimators. Three modes:
  - **Vocal + rhythm** *(default)* — keeps the singer plus centred kick, bass and snare, so you still have a groove to lock to.
  - **Vocal only** — the singer, high-passed clear of the rhythm section.
  - **Lead line** — a narrow formant band, for picking a melody out by ear.
- **Isolation slider** — blend the isolated signal against the untouched mix. At 0% it is bit-exact passthrough, so you always have an honest A/B.
- **Lead sheet panel** — chord symbols above time-synced lyrics, in the Chrome side panel. Lyrics come from Karalyr (word-synced where it has them) and LRCLib.
- **Transpose / capo** — a display-only shift, so a capo'd guitarist reads the shapes they're playing. Accidentals follow the estimated key: `Bb` in a flat key, never `A#`.

## How the isolation works

The mask is the product of two estimators that fail on different material.

**Centre extraction** asks *where* each frequency is panned. It is cheap and it is the whole of what most browser-based vocal tools do — but it is a pan estimator, so it cannot separate a centred singer from a centred kick, bass or rhythm guitar. They score identically. Tightening it does not help; that is the ceiling of the method, and it is why a plain centre-channel filter leaves you listening to most of the band.

**Online REPET** asks whether that same energy *was also there a bar ago*. The band replays the bar; the singer does not re-sing it. Instrufilt keeps a rolling ~11 s history of the spectrum in 64 log-spaced bands, slices it into twelve time buckets, takes the closest-matching frame from each, and treats the median across those matches as the backing track. Whatever the current frame has in excess of that estimate is the vocal.

It only ever looks **backwards**, so it adds no latency: the group delay is one FFT frame, 2048 samples (43 ms at 48 kHz), exactly as before. Cost is about +1% of the DSP at 48 kHz.

On the synthetic case in `iso_test.c` — a repeating riff and an aperiodic melody, both dead centre, so centre extraction cannot tell them apart at all — the stage holds the lead at 0.95x while pushing the backing to 0.03x.

REPET is deliberately **off in Vocal + rhythm**: that mode exists to keep the centred rhythm section, which is the most repetitive thing in the mix and so the first thing REPET removes. **Switch to Vocal only or Lead line to hear it.**

Its one real limit is the mirror of how it works: a phrase the singer repeats identically inside the ~11 s window looks like backing, and gets treated as backing.

## How chords work

Charts come from two sources, best one wins:

1. **Songle (online, verified)** — when the song is a YouTube video and [Songle](https://songle.jp), AIST's music-understanding research service, has analysed it, Instrufilt fetches that chart: millisecond-accurate, with 7ths, sus and slash chords. Only the video's address is sent — **audio still never leaves the browser.** The panel credits "Chords: Songle (AIST)" whenever their data is shown (their terms require it, and it also tells you the chart is trustworthy). Toggle **Online chords** off to stay fully local. Songle is non-commercial-only and may change without notice; charts from it are cached on your device only and are never contributed anywhere.
2. **On-device detection (always available)** — everything below, unchanged, and the automatic fallback for the ~half of songs Songle does not know, for Spotify, and for the toggle-off case.

The song row also carries two zero-magic learn buttons: **How to play ↗** (a YouTube tutorial search for the current song and your instrument) and **Tab ↗** (the song on Songsterr). Tapping the big current-chord readout opens a fingering diagram for the current and next chord.

On-device detection works from the audio itself — no lookup, no account, works on any song.

Detection is real-time, which means on the **first play** a chord is recognised slightly *after* it starts sounding. That is useless for playing along, so Instrufilt does not pretend otherwise:

| | |
|---|---|
| **First play — "Listening"** | Chords appear dimmed and italic as they are recognised. The panel is building a chart, and says so. |
| **Every play after — "Chart"** | The whole lead sheet renders up front, *ahead* of the playhead, re-decoded offline for accuracy and cached per song. |

Charts are auto-detected and imperfect. On synthetic triads the detector scores ~94%; on real recordings expect roughly **55–65% on clean pop and rock**, lower on dense, distorted or live material, and poor on anything with sparse harmony. Chords below the confidence threshold are drawn with a dotted underline — those are the ones to check first.

Known limits worth knowing before you trust a locally-detected chart (a Songle chart has none of these):

- **Relative major/minor confusion** (C↔Am) is the most common error; they share two of three notes, and only the bass separates them.
- **Major and minor triads only.** No 7ths — at this feature quality a 7th is inside the noise floor, and chasing them produces a chart that flip-flops between `C` and `Cmaj7` rather than a richer one.
- **Power chords** have no third at all, so major/minor is a coin flip on distorted guitar.
- **Pitch-shifted uploads** are handled: tuning is estimated continuously, so a track uploaded at A=432 still charts correctly.

## Install (development)

```bash
git clone <this repo> && cd instrufilt
source ~/emsdk/emsdk_env.sh     # only if you're changing the DSP
make                            # builds wasm/build/vocal_isolate.wasm
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this directory.

The compiled `.wasm` is committed, so you only need emscripten if you change the DSP. Everything else is plain JS with no build step — edit and reload.

## Develop

```bash
make                   # build the wasm
make test-native       # DSP + chroma assertions, native gcc (no emscripten needed)
make test              # everything: native + node suites + vendoring
node test/chord-pipeline.test.mjs    # end-to-end: wasm -> viterbi -> chart
node test/vendor-drift.test.mjs      # vendoring integrity on its own
```

`make test-native` is the fast loop — it compiles the same C with gcc and asserts on the numbers directly, so you can iterate on the DSP without emscripten in the way.

## Shared code

Instrufilt vendors several files **verbatim** from Karafilt — song identification, video keys, line tokenisation, the site adapters:

```bash
scripts/sync-shared.sh            # pull upstream changes in
scripts/sync-shared.sh --check    # verify nothing has drifted or been tampered with
```

`vendor/MANIFEST.json` is the contract, and it records *why* each file is shared. **Never edit a vendored file in place** — make the change in Karafilt and re-sync, so both extensions get it. `make test` fails if you do.

## Relationship to the rest of the family

| | |
|---|---|
| **[Karafilt](https://karafilt.com)** | Removes the vocal. For singers. Shares this DSP chassis and the lyrics stack. |
| **[Karalyr](https://karalyr.com)** | Open word-synced lyrics database. Instrufilt reads lyrics from it, and will read community-verified chords from it in a later release. |

## Licence

MIT. Bundles [KissFFT](https://github.com/mborgerding/kissfft) (BSD-3-Clause).
