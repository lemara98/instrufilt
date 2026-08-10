// Guitar fingering shapes and the SVG fretboard that draws them.
//
// Deliberately hand-rolled rather than vendored: the obvious libraries are
// either GPL (ChordSheetJS), dormant (VexChords), or packaged for bundlers
// this project does not have (svguitar). A shape dictionary plus ~60 lines of
// SVG covers every chord the two chart sources can actually emit.
//
// The model is CAGED-lite: a table of common OPEN shapes for the diagrams
// guitarists expect to see ("C" should look like C, not like an A-barre at
// fret 3), and E-/A-family barre templates for every other root. Qualities
// that have no honest 6-string shape (dim, aug, alterations) return null —
// the tray then shows just the label, which beats showing a wrong grip.
//
// shapeFor() is pure and Node-testable; renderInto() touches the DOM and only
// runs in the panel.
//
// Shape format, borrowed from the chords-db convention:
//   frets    six entries, LOW E first: -1 mute, 0 open, n = finger at fret n
//            counted from baseFret (1 = the first drawn row)
//   baseFret 1 for open position (nut drawn); f>1 = grid starts at fret f
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InstrufiltChordShapes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Movable templates, fret offsets relative to the barre. Root pitch class of
  // the open shape: E family 4 (string 6), A family 9 (string 5).
  const BARRE = {
    E: {
      maj:  [0, 2, 2, 1, 0, 0],
      min:  [0, 2, 2, 0, 0, 0],
      7:    [0, 2, 0, 1, 0, 0],
      m7:   [0, 2, 0, 0, 0, 0],
      maj7: [0, 2, 1, 1, 0, 0],
      sus4: [0, 2, 2, 2, 0, 0],
    },
    A: {
      maj:  [-1, 0, 2, 2, 2, 0],
      min:  [-1, 0, 2, 2, 1, 0],
      7:    [-1, 0, 2, 0, 2, 0],
      m7:   [-1, 0, 2, 0, 1, 0],
      maj7: [-1, 0, 2, 1, 2, 0],
      sus4: [-1, 0, 2, 2, 3, 0],
      sus2: [-1, 0, 2, 2, 0, 0],
    },
  };

  // Open-position shapes, absolute frets, baseFret 1. Keyed "pc|kind".
  const OPEN = {
    "0|maj":  [-1, 3, 2, 0, 1, 0],   // C
    "0|7":    [-1, 3, 2, 3, 1, 0],   // C7
    "0|maj7": [-1, 3, 2, 0, 0, 0],   // Cmaj7
    "2|maj":  [-1, -1, 0, 2, 3, 2],  // D
    "2|min":  [-1, -1, 0, 2, 3, 1],  // Dm
    "2|7":    [-1, -1, 0, 2, 1, 2],  // D7
    "2|m7":   [-1, -1, 0, 2, 1, 1],  // Dm7
    "2|maj7": [-1, -1, 0, 2, 2, 2],  // Dmaj7
    "2|sus2": [-1, -1, 0, 2, 3, 0],  // Dsus2
    "2|sus4": [-1, -1, 0, 2, 3, 3],  // Dsus4
    "4|maj":  [0, 2, 2, 1, 0, 0],    // E
    "4|min":  [0, 2, 2, 0, 0, 0],    // Em
    "4|7":    [0, 2, 0, 1, 0, 0],    // E7
    "4|m7":   [0, 2, 0, 0, 0, 0],    // Em7
    "4|maj7": [0, 2, 1, 1, 0, 0],    // Emaj7
    "4|sus4": [0, 2, 2, 2, 0, 0],    // Esus4
    "5|maj7": [-1, -1, 3, 2, 1, 0],  // Fmaj7
    "7|maj":  [3, 2, 0, 0, 0, 3],    // G
    "7|7":    [3, 2, 0, 0, 0, 1],    // G7
    "9|maj":  [-1, 0, 2, 2, 2, 0],   // A
    "9|min":  [-1, 0, 2, 2, 1, 0],   // Am
    "9|7":    [-1, 0, 2, 0, 2, 0],   // A7
    "9|m7":   [-1, 0, 2, 0, 1, 0],   // Am7
    "9|maj7": [-1, 0, 2, 1, 2, 0],   // Amaj7
    "9|sus2": [-1, 0, 2, 2, 0, 0],   // Asus2
    "9|sus4": [-1, 0, 2, 2, 3, 0],   // Asus4
    "11|7":   [-1, 2, 1, 2, 0, 2],   // B7
  };

  /**
   * {quality, ext} -> the template kind, or null for shapes better left
   * undrawn. Extensions past the template's reach degrade to the nearest
   * honest simplification (add9 -> triad, 13 -> 7): playing the plain shape
   * under the recording is right; a fabricated grip is not.
   */
  function templateKind(quality, ext) {
    const e = ext || "";
    const minor = quality === 1;
    if (!e) return minor ? "min" : "maj";
    // An altered fifth changes the grip, not just the colour — "m7b5" played
    // as m7 is simply the wrong chord. No template, no diagram.
    if (/b5|#5|dim|aug|\+/.test(e)) return null;
    if (e === "M7" || e === "maj7") return minor ? null : "maj7";
    if (/^sus2/.test(e)) return "sus2";
    if (/^sus4|^sus$/.test(e)) return "sus4";
    if (/^7sus/.test(e)) return "sus4";
    if (/^(7|9|11|13)/.test(e)) return minor ? "m7" : "7";
    if (/^(6|add)/.test(e)) return minor ? "min" : "maj";
    return null;   // dim, aug, b5, alt... no honest 6-string template
  }

  /**
   * @param {{root:number, quality:number, ext?:string}} chord
   * @returns {{frets:number[], baseFret:number}|null}
   */
  function shapeFor(chord) {
    if (!chord || typeof chord.root !== "number" || chord.root < 0) return null;
    const kind = templateKind(chord.quality, chord.ext);
    if (!kind) return null;
    const pc = ((chord.root % 12) + 12) % 12;

    const open = OPEN[`${pc}|${kind === "min" ? "min" : kind}`];
    if (open) return { frets: open.slice(), baseFret: 1 };

    // Barre: whichever family puts the hand lower on the neck.
    const fE = (pc - 4 + 12) % 12;
    const fA = (pc - 9 + 12) % 12;
    const candidates = [];
    if (BARRE.E[kind] && fE > 0) candidates.push({ f: fE, tpl: BARRE.E[kind] });
    if (BARRE.A[kind] && fA > 0) candidates.push({ f: fA, tpl: BARRE.A[kind] });
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.f - b.f);
    const { f, tpl } = candidates[0];
    return {
      frets: tpl.map((v) => (v < 0 ? -1 : v + 1)),
      baseFret: f,
    };
  }

  // ── SVG ─────────────────────────────────────────────────────────────────

  const NS = "http://www.w3.org/2000/svg";
  const LEFT = 12, TOP = 20, STRING_GAP = 12, FRET_GAP = 15, FRETS_SHOWN = 5;

  function el(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  /** Draws `shape` into `svg` (viewBox 0 0 84 100). Null clears it. */
  function renderInto(svg, shape) {
    if (!svg) return;
    svg.textContent = "";
    if (!shape) return;

    const grid = el("g", { stroke: "currentColor", "stroke-width": "1" });
    for (let s = 0; s < 6; s++) {
      grid.appendChild(el("line", {
        x1: LEFT + s * STRING_GAP, y1: TOP,
        x2: LEFT + s * STRING_GAP, y2: TOP + FRETS_SHOWN * FRET_GAP,
      }));
    }
    for (let f = 0; f <= FRETS_SHOWN; f++) {
      grid.appendChild(el("line", {
        x1: LEFT, y1: TOP + f * FRET_GAP,
        x2: LEFT + 5 * STRING_GAP, y2: TOP + f * FRET_GAP,
      }));
    }
    svg.appendChild(grid);

    if (shape.baseFret <= 1) {
      // The nut.
      svg.appendChild(el("rect", {
        x: LEFT - 1, y: TOP - 3, width: 5 * STRING_GAP + 2, height: 3,
        fill: "currentColor",
      }));
    } else {
      const label = el("text", {
        x: LEFT - 4, y: TOP + FRET_GAP * 0.5 + 3,
        "text-anchor": "end", "font-size": "8", fill: "currentColor",
      });
      label.textContent = String(shape.baseFret);
      svg.appendChild(label);
    }

    shape.frets.forEach((v, s) => {
      const x = LEFT + s * STRING_GAP;
      if (v === -1) {
        const mute = el("text", {
          x, y: TOP - 6, "text-anchor": "middle", "font-size": "8",
          fill: "currentColor",
        });
        mute.textContent = "×";
        svg.appendChild(mute);
      } else if (v === 0) {
        svg.appendChild(el("circle", {
          cx: x, cy: TOP - 9, r: 2.6,
          fill: "none", stroke: "currentColor", "stroke-width": "1",
        }));
      } else {
        svg.appendChild(el("circle", {
          cx: x, cy: TOP + (v - 0.5) * FRET_GAP, r: 4.4,
          style: "fill: var(--ifA)",
        }));
      }
    });
  }

  return { shapeFor, renderInto, templateKind, OPEN, BARRE };
});
