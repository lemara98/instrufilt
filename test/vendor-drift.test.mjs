// Instrufilt — vendoring integrity tests
//
//   node test/vendor-drift.test.mjs
//   KARAFILT_REPO=/path/to/karafilt node test/vendor-drift.test.mjs
//   STRICT_VENDOR=1 node test/vendor-drift.test.mjs     upstream drift also fails
//
// Pure Node, no deps — same shape as the vendored Karafilt tests.
//
// Three layers, in increasing strength:
//
//   1. HASH INTEGRITY   every vendored file matches vendor/MANIFEST.json.
//                       Always runnable, needs no Karafilt checkout. The CI gate.
//   2. UPSTREAM DRIFT   Karafilt's copy still matches. Only checkable when a
//                       checkout is present; informational unless STRICT_VENDOR=1.
//   3. BEHAVIOURAL      Karafilt's own test suites run UNMODIFIED against the
//                       vendored copies. This is the real proof: it catches
//                       "hash matched but a global collided", which layer 1 can't.

import assert from "node:assert";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "vendor", "MANIFEST.json");

const STRICT = process.env.STRICT_VENDOR === "1";

let failures = 0;
let drifted = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "manifest has files");

// ---------------------------------------------------------------- layer 1
console.log("\nvendor hash integrity");

for (const entry of manifest.files) {
  check(entry.path, () => {
    const file = path.join(ROOT, entry.path);
    assert.ok(existsSync(file), `vendored file missing: ${entry.path}`);
    assert.notStrictEqual(
      entry.sha256,
      null,
      `no hash recorded — run scripts/sync-shared.sh`
    );
    const actual = sha256(file);
    assert.strictEqual(
      actual,
      entry.sha256,
      `edited in place.\n       ` +
        `Vendored files are copied verbatim from Karafilt and must never be\n       ` +
        `edited here. Either revert the change and make it upstream, or move\n       ` +
        `this file out of vendor/MANIFEST.json into _promotions with a reason.`
    );
  });
}

// ---------------------------------------------------------------- layer 2
const upstream = process.env.KARAFILT_REPO
  ? path.resolve(process.env.KARAFILT_REPO)
  : path.resolve(ROOT, manifest.upstream.defaultPath);

console.log("\nupstream drift");

if (!existsSync(upstream)) {
  console.log(`  skip  no Karafilt checkout at ${upstream}`);
  console.log(`        (set KARAFILT_REPO to enable — hash integrity above still ran)`);
} else {
  for (const entry of manifest.files) {
    const file = path.join(upstream, entry.path);
    if (!existsSync(file)) {
      failures++;
      console.error(`  FAIL ${entry.path}\n       absent upstream at ${upstream}`);
      continue;
    }
    if (sha256(file) !== entry.sha256) {
      drifted++;
      const msg = `${entry.path}\n       upstream has moved on — run scripts/sync-shared.sh`;
      if (STRICT) {
        failures++;
        console.error(`  FAIL ${msg}`);
      } else {
        console.log(`  DRIFT ${msg}`);
      }
    } else {
      console.log(`  ok   ${entry.path}`);
    }
  }
}

// ---------------------------------------------------------------- layer 3
//
// The vendoring proof. A hash match says the bytes are identical; it says
// nothing about whether the file still *works* here — a global could collide
// with one of ours, or a sibling module it depends on could be missing. Running
// Karafilt's own suites unmodified is what actually establishes that.
console.log("\nvendored suites run unmodified");

const VENDORED_SUITES = manifest.files
  .map((e) => e.path)
  .filter((p) => p.startsWith("test/") && p.endsWith(".test.mjs"));

assert.ok(VENDORED_SUITES.length > 0, "expected at least one vendored suite");

for (const suite of VENDORED_SUITES) {
  check(`${suite} passes against our vendored copy`, () => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, suite)], {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (err) {
      const out = [err.stdout, err.stderr]
        .filter(Boolean)
        .map((b) => b.toString())
        .join("\n")
        .trim();
      throw new Error(`exited ${err.status}\n${out.split("\n").slice(-12).join("\n")}`);
    }
  });
}

// ----------------------------------------------------------------- summary
console.log("");
if (drifted > 0 && !STRICT) {
  console.log(`${drifted} file(s) drifted from upstream — informational, not a failure.`);
  console.log(`Run scripts/sync-shared.sh to pull them in, or STRICT_VENDOR=1 to fail here.`);
}
if (failures > 0) {
  console.error(`${failures} vendoring check(s) failed`);
  process.exit(1);
}
console.log(`vendoring OK — ${manifest.files.length} files, ${VENDORED_SUITES.length} suites`);
