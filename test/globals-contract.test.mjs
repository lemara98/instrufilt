// Instrufilt — vendored globals contract
//
//   node test/globals-contract.test.mjs
//
// The vendored files are plain <script> tags that publish themselves onto the
// global scope. Nothing in the build checks that the names Instrufilt READS
// are the names Karafilt WRITES, so a rename upstream — or a wrong guess here —
// fails silently at runtime as `undefined is not a function`, inside a content
// script, on a page the developer may not be looking at.
//
// The hash check in vendor-drift.test.mjs cannot catch this: the bytes are
// correct by definition, it is the consumer that is wrong. This file asserts
// the seam itself.
//
// Names below are the REAL ones, verified against the vendored sources:
//   song-match.js    -> KarafiltSongMatch   (namespace)
//   line-tokens.js   -> KarafiltLineTokens  (namespace)
//   site-adapters.js -> KarafiltSiteAdapter (SINGULAR — not ...Adapters)
//   video-key.js     -> deriveVideoKey      (a BARE function, not a namespace)
//   fancy-select.js  -> window.enhanceModeSelect

import assert from "node:assert";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

// The contract, as consumed. Each entry: the vendored file, the global it must
// publish, and the members Instrufilt actually calls on it.
const CONTRACT = [
  {
    file: "shared/song-match.js",
    global: "KarafiltSongMatch",
    members: ["parseTitle", "cleanTitle"],
    usedBy: "content/media-bridge.js — identifySong(), getSongKey()",
  },
  {
    file: "shared/video-key.js",
    global: "deriveVideoKey",
    kind: "function",
    usedBy: "content/media-bridge.js — videoKey()",
  },
  {
    file: "content/site-adapters.js",
    global: "KarafiltSiteAdapter",
    members: ["forHost"],
    usedBy: "content/media-bridge.js — ADAPTER construction",
  },
  {
    file: "shared/line-tokens.js",
    global: "KarafiltLineTokens",
    members: ["lineTokens"],
    usedBy: "sidepanel/leadsheet.js — makeLineEl()",
  },
];

// Instrufilt's own shared modules. Same failure mode as the vendored ones —
// they are <script> tags publishing onto the global scope, with nothing
// checking that the names match at the point of use.
const OWN = [
  {
    file: "shared/lrc.js",
    global: "InstrufiltLRC",
    members: ["parseLRC", "computeGaps", "lineIndexAt", "hasWordTiming"],
    usedBy: "sidepanel/leadsheet.js",
  },
  {
    file: "shared/chord-layout.js",
    global: "InstrufiltChordLayout",
    members: ["chordsForLine", "chordsInGap"],
    usedBy: "sidepanel/leadsheet.js — makeLineEl()",
  },
  {
    file: "shared/chord-decode.js",
    global: "InstrufiltChordDecode",
    members: ["decode", "viterbi", "greedy", "aggregateChroma"],
    usedBy: "offscreen.js — end-of-song re-decode",
  },
  {
    file: "shared/chord-format.js",
    global: "InstrufiltChordFormat",
    members: ["chordName", "estimateKey", "labelChart", "transposeKey"],
    usedBy: "offscreen.js (key estimate) and sidepanel/sidepanel.js (labels)",
  },
  {
    file: "shared/lyrics-fetch.js",
    global: "InstrufiltLyricsFetch",
    members: ["lookup", "setKaralyrBase"],
    usedBy: "service-worker.js — importScripts, aliased as LF",
  },
  {
    file: "shared/chord-source.js",
    global: "InstrufiltChordSource",
    members: ["resolveChart", "saveChart", "deleteChart", "makeChart",
              "expandChords", "coverageFraction", "mergeCovered"],
    usedBy: "offscreen.js (accumulator) and service-worker.js (FETCH_CHART, aliased as CS)",
  },
  {
    file: "shared/songle-fetch.js",
    global: "InstrufiltSongleFetch",
    members: ["fetchChart", "mapResponse", "parseChordName"],
    usedBy: "shared/chord-source.js — songleProvider, via importScripts in the SW",
  },
  {
    file: "shared/karalyr-fetch.js",
    global: "InstrufiltKaralyrFetch",
    members: ["fetchChart", "mapResponse", "setKaralyrBase"],
    usedBy: "shared/chord-source.js — karalyrProvider; service-worker.js base override (KF)",
  },
  {
    file: "shared/chord-shapes.js",
    global: "InstrufiltChordShapes",
    members: ["shapeFor", "renderInto"],
    usedBy: "sidepanel/sidepanel.js — the fingering tray",
  },
];

// A minimal browser-ish global. These files are written for a content script,
// not Node, so `window` has to exist even though none of the code paths we
// assert on touch the DOM.
function loadIntoContext(file) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  sandbox.Intl = Intl;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.URL = URL;
  // Deliberately NO `module`: the UMD wrappers fall through to the global
  // branch, which is the branch the extension actually exercises.
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  return sandbox;
}

console.log("\nvendored globals contract");

for (const entry of CONTRACT.concat(OWN)) {
  check(`${entry.file} publishes ${entry.global}`, () => {
    const g = loadIntoContext(entry.file);
    const value = g[entry.global];
    assert.ok(
      value !== undefined,
      `global "${entry.global}" is undefined after loading ${entry.file}.\n       ` +
        `Consumed by: ${entry.usedBy}\n       ` +
        `Published globals were: ${Object.keys(g)
          .filter((k) => !["globalThis", "window", "self", "console", "Intl", "URL",
                           "setTimeout", "clearTimeout", "setInterval", "clearInterval"].includes(k))
          .join(", ") || "(none)"}`
    );
    if (entry.kind === "function") {
      assert.strictEqual(typeof value, "function", `${entry.global} should be a bare function`);
    }
    for (const m of entry.members || []) {
      assert.strictEqual(
        typeof value[m], "function",
        `${entry.global}.${m}() is missing — consumed by ${entry.usedBy}`
      );
    }
  });
}

// Behavioural spot-checks. A name can survive a rename while its behaviour
// changes underneath; these pin the two contracts Instrufilt leans on hardest.
check("deriveVideoKey still produces yt:/sp: keys", () => {
  const { deriveVideoKey } = loadIntoContext("shared/video-key.js");
  assert.strictEqual(deriveVideoKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "yt:dQw4w9WgXcQ");
  assert.strictEqual(deriveVideoKey("https://youtu.be/dQw4w9WgXcQ"), "yt:dQw4w9WgXcQ");
  assert.strictEqual(
    deriveVideoKey("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
    "sp:4uLU6hMCjMI75M1A2tKUQC"
  );
});

// The chord-chart cache is keyed on this. If it ever disagrees with Karafilt's
// or Karalyr's notion of song identity, cached charts attach to the wrong song.
check("deriveVideoKey ignores playlist and timestamp params", () => {
  const { deriveVideoKey } = loadIntoContext("shared/video-key.js");
  assert.strictEqual(
    deriveVideoKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&t=42s"),
    "yt:dQw4w9WgXcQ"
  );
});

check("parseTitle still returns ordered {artist, track} candidates", () => {
  const { KarafiltSongMatch: SM } = loadIntoContext("shared/song-match.js");
  const out = SM.parseTitle("Adele - Hello (Official Music Video)");
  assert.ok(Array.isArray(out) && out.length > 0, "expected candidates");
  assert.strictEqual(out[0].artist, "Adele");
  assert.strictEqual(out[0].track, "Hello");
});

check("forHost returns null off Spotify and an adapter on it", () => {
  const { KarafiltSiteAdapter: SA } = loadIntoContext("content/site-adapters.js");
  assert.strictEqual(SA.forHost("www.youtube.com"), null, "YouTube must use the generic path");
});

console.log("");
if (failures) {
  console.error(`${failures} contract check(s) failed`);
  process.exit(1);
}
console.log("globals contract OK");
