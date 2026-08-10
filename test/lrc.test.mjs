// Instrufilt — LRC parsing and gap detection
//
//   node test/lrc.test.mjs

import assert from "node:assert";
import LRC from "../shared/lrc.js";

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

console.log("\nparseLRC");

check("parses plain line timestamps", () => {
  const out = LRC.parseLRC("[00:12.34]hello world\n[00:15.00]second line");
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].time, 12.34);
  assert.strictEqual(out[0].text, "hello world");
  assert.strictEqual(out[1].time, 15);
});

check("ignores metadata tags and untimed lines", () => {
  const out = LRC.parseLRC("[ar:Adele]\n[ti:Hello]\nno timestamp here\n[00:01.00]real");
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, "real");
});

check("one line with several timestamps emits one entry each", () => {
  const out = LRC.parseLRC("[00:10.00][01:20.00][02:30.00]chorus");
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((l) => l.time), [10, 80, 150]);
  assert.ok(out.every((l) => l.text === "chorus"));
});

check("output is sorted by time even when the file is not", () => {
  const out = LRC.parseLRC("[00:30.00]third\n[00:10.00]first\n[00:20.00]second");
  assert.deepStrictEqual(out.map((l) => l.text), ["first", "second", "third"]);
});

check("accepts colon as a fractional separator", () => {
  const out = LRC.parseLRC("[02:15:30]odd but real");
  assert.ok(Math.abs(out[0].time - 135.3) < 1e-9, `got ${out[0].time}`);
});

check("empty and non-string input yield no lines", () => {
  assert.deepStrictEqual(LRC.parseLRC(""), []);
  assert.deepStrictEqual(LRC.parseLRC(null), []);
  assert.deepStrictEqual(LRC.parseLRC(undefined), []);
});

console.log("\nEnhanced LRC word timing");

check("extracts per-word times and strips the tags from text", () => {
  const out = LRC.parseLRC("[00:10.00]<00:10.00>Hello <00:10.50>darkness <00:11.20>friend");
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].text, "Hello darkness friend");
  assert.deepStrictEqual(out[0].words, [
    { time: 10.0, text: "Hello" },
    { time: 10.5, text: "darkness" },
    { time: 11.2, text: "friend" },
  ]);
});

check("a word's text runs to the NEXT tag, not its own", () => {
  // The classic off-by-one: reading forward from a tag to the following tag is
  // what makes the last word work at all, since nothing closes it but EOL.
  const out = LRC.parseLRC("[00:00.00]<00:00.00>a <00:01.00>b");
  assert.deepStrictEqual(out[0].words.map((w) => w.text), ["a", "b"]);
});

check("plain lines carry no words array", () => {
  const out = LRC.parseLRC("[00:10.00]no word tags here");
  assert.strictEqual(out[0].words, undefined);
});

check("hasWordTiming distinguishes the two", () => {
  assert.strictEqual(LRC.hasWordTiming(LRC.parseLRC("[00:01.00]plain")), false);
  assert.strictEqual(LRC.hasWordTiming(LRC.parseLRC("[00:01.00]<00:01.00>timed")), true);
});

check("word tags with no text between them are dropped", () => {
  const out = LRC.parseLRC("[00:00.00]<00:00.00> <00:01.00>real");
  assert.deepStrictEqual(out[0].words.map((w) => w.text), ["real"]);
});

console.log("\ncomputeGaps");

check("a long intro is a gap", () => {
  const gaps = LRC.computeGaps(LRC.parseLRC("[00:12.00]first line"));
  assert.strictEqual(gaps.length, 1);
  assert.deepStrictEqual(gaps[0], { start: 0, end: 12, nextIndex: 0 });
});

check("a short intro is not", () => {
  assert.deepStrictEqual(LRC.computeGaps(LRC.parseLRC("[00:03.00]first")), []);
});

check("mid-song gaps need word timing to be detectable", () => {
  // Plain LRC carries only line STARTS, so there is no way to know when the
  // singing stopped — every long line would otherwise read as a gap.
  const plain = LRC.parseLRC("[00:00.00]one\n[00:40.00]two");
  assert.deepStrictEqual(LRC.computeGaps(plain), [], "plain LRC must not invent mid-song gaps");

  const timed = LRC.parseLRC("[00:00.00]<00:00.00>one\n[00:40.00]<00:40.00>two");
  const gaps = LRC.computeGaps(timed);
  assert.strictEqual(gaps.length, 1);
  assert.ok(Math.abs(gaps[0].start - 1.2) < 1e-9, `start ${gaps[0].start}`);
  assert.strictEqual(gaps[0].end, 40);
  assert.strictEqual(gaps[0].nextIndex, 1);
});

check("a gap shorter than the threshold is ignored", () => {
  const timed = LRC.parseLRC("[00:00.00]<00:00.00>one\n[00:05.00]<00:05.00>two");
  assert.deepStrictEqual(LRC.computeGaps(timed), []);
});

check("no lines yields no gaps", () => {
  assert.deepStrictEqual(LRC.computeGaps([]), []);
  assert.deepStrictEqual(LRC.computeGaps(null), []);
});

console.log("\nlineIndexAt");

const lines = LRC.parseLRC("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");

check("finds the last line at or before t", () => {
  assert.strictEqual(LRC.lineIndexAt(lines, 9.9), -1);
  assert.strictEqual(LRC.lineIndexAt(lines, 10), 0);
  assert.strictEqual(LRC.lineIndexAt(lines, 19.9), 0);
  assert.strictEqual(LRC.lineIndexAt(lines, 20), 1);
  assert.strictEqual(LRC.lineIndexAt(lines, 999), 2);
});

check("is stateless — seeking backward self-corrects", () => {
  // The property the whole sync design leans on: no cursor to invalidate, so
  // a seek needs no handling anywhere. Walk forward then jump back.
  assert.strictEqual(LRC.lineIndexAt(lines, 30), 2);
  assert.strictEqual(LRC.lineIndexAt(lines, 10), 0);
  assert.strictEqual(LRC.lineIndexAt(lines, 25), 1);
});

check("empty line list returns -1", () => {
  assert.strictEqual(LRC.lineIndexAt([], 5), -1);
});

console.log("");
if (failures) {
  console.error(`${failures} LRC test(s) failed`);
  process.exit(1);
}
console.log("LRC OK");
