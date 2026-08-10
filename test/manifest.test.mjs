// Instrufilt — manifest integrity
//
//   node test/manifest.test.mjs
//
// A manifest that names a file which does not exist makes Chrome refuse to load
// the whole extension, with an error that points at the manifest rather than at
// whatever rename caused it. Cheap to check, annoying to debug.
//
// Karafilt only catches this at package time (scripts/package.sh). Catching it
// in `make test` means a rename is caught on the commit that made it.

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
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

const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

// Every string anywhere in the manifest that looks like a bundled file path.
const FILE_RE = /\.(js|html|css|png|svg|json|wasm)$/;
const refs = new Set();
(function walk(node) {
  if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === "object") Object.values(node).forEach(walk);
  else if (typeof node === "string" && FILE_RE.test(node) && !/^https?:/.test(node)) refs.add(node);
})(manifest);

console.log("\nmanifest references");
assert.ok(refs.size > 0, "expected the manifest to reference some files");
for (const ref of [...refs].sort()) {
  check(ref, () => assert.ok(existsSync(path.join(ROOT, ref)), `referenced but missing: ${ref}`));
}

// Files loaded at runtime rather than declared in the manifest, so nothing
// above would catch them going missing.
console.log("\nruntime-loaded files");
const RUNTIME = [
  // chrome.offscreen.createDocument({url: "offscreen.html"})
  ["offscreen.html", "service-worker.js — ensureOffscreenDocument()"],
  // chrome.runtime.getURL(...) inside the offscreen document
  ["offscreen.js", "offscreen.html"],
  ["worklet-processor.js", "offscreen.js — audioWorklet.addModule()"],
];
for (const [file, loader] of RUNTIME) {
  check(`${file} (loaded by ${loader})`, () =>
    assert.ok(existsSync(path.join(ROOT, file)), `missing: ${file}`));
}

// Parsed rather than listed, so a script added to either page is covered
// without anyone remembering to update this file.
console.log("\noffscreen.html assets");
const offscreenHtml = readFileSync(path.join(ROOT, "offscreen.html"), "utf8");
for (const m of offscreenHtml.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  check(m[1], () => assert.ok(existsSync(path.join(ROOT, m[1])),
    `offscreen.html references a missing file: ${m[1]}`));
}

console.log("\nsidepanel.html assets");
const panelDir = path.join(ROOT, "sidepanel");
const panelHtml = readFileSync(path.join(panelDir, "sidepanel.html"), "utf8");
const assetRefs = [
  ...panelHtml.matchAll(/<script[^>]+src="([^"]+)"/g),
  ...panelHtml.matchAll(/<link[^>]+href="([^"]+)"/g),
].map((m) => m[1]).filter((r) => !/^https?:/.test(r));

assert.ok(assetRefs.length > 0, "expected sidepanel.html to reference assets");
for (const ref of assetRefs) {
  check(ref, () =>
    assert.ok(existsSync(path.resolve(panelDir, ref)), `sidepanel.html references a missing file: ${ref}`));
}

// Same for the service worker's importScripts, which fails the whole SW at
// startup with an error that names the importer rather than the missing file.
console.log("\nservice-worker importScripts");
const swSrc = readFileSync(path.join(ROOT, "service-worker.js"), "utf8");
const importMatch = swSrc.match(/importScripts\(([^)]*)\)/);
const imported = importMatch ? [...importMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
assert.ok(imported.length > 0, "expected the service worker to importScripts something");
for (const ref of imported) {
  check(ref, () => assert.ok(existsSync(path.join(ROOT, ref)), `importScripts references a missing file: ${ref}`));
}

// The .wasm is a build artifact, committed so contributors need emscripten only
// when touching the DSP. Absent before the first `make`, so this is a warning.
console.log("\nbuild artifact");
const wasm = path.join(ROOT, "wasm/build/vocal_isolate.wasm");
if (existsSync(wasm)) {
  console.log("  ok   wasm/build/vocal_isolate.wasm");
} else {
  console.log("  WARN wasm/build/vocal_isolate.wasm not built — run `make` (needs emscripten)");
  console.log("       The extension cannot isolate audio until this exists.");
}

// Cross-check the manifest against what the code actually asks for. A stale
// permission is a Web Store review question; a missing one is a runtime failure
// with no obvious cause.
console.log("\npermissions");
const perms = new Set(manifest.permissions || []);
for (const p of ["tabCapture", "offscreen", "storage", "sidePanel", "activeTab", "tabs", "contextMenus"]) {
  check(`declares "${p}"`, () => assert.ok(perms.has(p), `service-worker.js uses chrome.${p.replace("sidePanel","sidePanel")}`));
}
check('does NOT declare "alarms"', () =>
  assert.ok(!perms.has("alarms"), "alarms exists only for Karafilt's usage heartbeat; not ported"));
check('does NOT declare "unlimitedStorage"', () =>
  assert.ok(!perms.has("unlimitedStorage"), "chord charts are ~12KB/song; this only invites review questions"));

check("CSP allows wasm", () => {
  const csp = (manifest.content_security_policy || {}).extension_pages || "";
  assert.ok(csp.includes("wasm-unsafe-eval"), "the AudioWorklet compiles WebAssembly");
});

check("keyboard shortcut avoids DevTools", () => {
  const keys = Object.values(manifest.commands || {}).map((c) => (c.suggested_key || {}).default || "");
  for (const k of keys) {
    assert.ok(!/^Ctrl\+Shift\+I$/i.test(k), `${k} is DevTools on every platform`);
  }
});

console.log("");
if (failures) {
  console.error(`${failures} manifest check(s) failed`);
  process.exit(1);
}
console.log("manifest OK");
