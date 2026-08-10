// Instrufilt — the audio thread.
//
// Forked from Karafilt's worklet-processor.js. Two structural differences:
//
//   1. There is one processing path, not three. Karafilt carries a time-domain
//      "basic" mode alongside its STFT; a naive (L-R)/2 has no isolation
//      analogue, so it is gone. Isolation modes are a parameter of the same
//      STFT path (see MODES in vocal_isolate_stft.c), not separate code.
//
//   2. Views over the WASM heap are built once and never rebuilt, which is only
//      sound because the Makefile sets ALLOW_MEMORY_GROWTH=0. If the heap ever
//      grew, every Float32Array below would detach and this processor would
//      silently emit garbage with no error raised anywhere.

const RENDER_QUANTUM = 128;

const MODE_IDS = { vocal_only: 0, vocal_rhythm: 1, lead_line: 2 };

// Layout of one exported chroma frame — must match CHROMA_FRAME_FLOATS and the
// field order in chroma.c push_frame().
const FRAME_FLOATS = 28;
const EVENT_FLOATS = 6;

// Drain the WASM rings every this many render quanta. At 128 samples per
// quantum and 48 kHz that is ~85 ms, comfortably faster than the 43 ms chroma
// hop, so the 96-frame ring never comes close to overflowing. Batching matters:
// one postMessage per chroma frame would be 23/s of cross-thread traffic for
// data nothing consumes in real time.
const DRAIN_EVERY = 32;

class VocalIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options.processorOptions || {};
    this.ready = false;

    // Seeded from processorOptions rather than waiting for a message, so init
    // applies the right mode even if SET_MODE races ahead of the async WASM
    // load. Karafilt learned this one the hard way — see its comment at
    // offscreen.js:74.
    this.mode = opts.mode || "vocal_rhythm";
    this.amount = typeof opts.amount === "number" ? opts.amount : 1.0;
    this.makeupDb = typeof opts.makeupDb === "number" ? opts.makeupDb : null;
    this.autoGain = !!opts.autoGain;
    this.mono = !!opts.mono;
    // -1 means "whatever this mode says", which is the shipping behaviour.
    // Seeded here for the same reason `mode` is: SET_REPET can race the WASM load.
    this.repet = typeof opts.repet === "number" ? opts.repet : -1;

    this.sampleRateValue = opts.sampleRate || 48000;
    this.chromaOn = !!opts.chroma;
    this.drainCounter = 0;

    this.port.onmessage = (event) => {
      const d = event.data || {};
      switch (d.type) {
        case "SET_AMOUNT":
          this.amount = d.value;
          if (this.ready) this.exports.isolate_set_amount(d.value);
          break;
        case "SET_MODE":
          this.mode = d.value;
          if (this.ready) {
            this.exports.isolate_set_mode(modeId(d.value));
            // isolate_set_mode reapplies the mode's own makeup, so an explicit
            // user setting has to be restated or it would be silently lost.
            if (this.makeupDb !== null) this.exports.isolate_set_makeup_db(this.makeupDb);
          }
          break;
        case "SET_MAKEUP_DB":
          this.makeupDb = d.value;
          if (this.ready) this.exports.isolate_set_makeup_db(d.value);
          break;
        case "SET_AUTO_GAIN":
          this.autoGain = !!d.value;
          if (this.ready) this.exports.isolate_set_auto_gain(this.autoGain ? 1 : 0);
          break;
        case "SET_MONO":
          this.mono = !!d.value;
          if (this.ready) this.exports.isolate_set_mono(this.mono ? 1 : 0);
          break;
        case "SET_REPET":
          // -1 restores the mode's own strength; 0 disables the stage. Kept as
          // a raw float rather than a boolean so this doubles as the A/B knob.
          this.repet = d.value;
          if (this.ready) this.exports.isolate_set_repet(d.value);
          break;
        case "RESET_REPET":
          // A seek, a track change or an ad boundary: the ~11 s history now
          // spans two unrelated pieces of music, so its "background" would be a
          // median across the splice. Separate from RESET_CHROMA because the
          // trigger sets are not identical — discarding a chart invalidates the
          // chroma accumulator but not the audio timeline.
          if (this.ready) this.exports.isolate_repet_reset();
          break;
        case "SET_CHROMA":
          this.chromaOn = !!d.value;
          if (this.ready) this.exports.chroma_enable(this.chromaOn ? 1 : 0);
          break;
        case "RESET_CHROMA":
          // A seek or a song change: the 8192-sample rolling window would
          // otherwise straddle two unrelated pieces of music.
          if (this.ready) this.exports.chroma_reset();
          break;
      }
    };

    this._initWasm(opts.wasmModule);
  }

  async _initWasm(wasmModule) {
    // Same import-variant probing as Karafilt: which stubs emscripten wants
    // depends on its version and flags, and guessing wrong is a hard failure.
    const variants = [
      {
        env: { emscripten_notify_memory_growth: () => {} },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
          fd_write: () => 0,
          fd_seek: () => 0,
          fd_close: () => 0,
        },
      },
      { env: {} },
    ];

    for (const imports of variants) {
      try {
        this.instance = await WebAssembly.instantiate(wasmModule, imports);
        this.exports = this.instance.exports;
        this.memory = this.exports.memory;
        break;
      } catch {
        continue;
      }
    }

    if (!this.exports) {
      console.error("[instrufilt] WASM init failed with every import variant");
      return;
    }

    this.exports.isolate_init(this.sampleRateValue);
    this.exports.isolate_set_mode(modeId(this.mode));
    this.exports.isolate_set_amount(this.amount);
    if (this.makeupDb !== null) this.exports.isolate_set_makeup_db(this.makeupDb);
    this.exports.isolate_set_auto_gain(this.autoGain ? 1 : 0);
    this.exports.isolate_set_mono(this.mono ? 1 : 0);
    this.exports.isolate_set_repet(this.repet);

    this.exports.chroma_init(this.sampleRateValue);
    this.exports.chroma_enable(this.chromaOn ? 1 : 0);

    const buf = this.memory.buffer;
    this.inL = new Float32Array(buf, this.exports.isolate_get_input_l(), RENDER_QUANTUM);
    this.inR = new Float32Array(buf, this.exports.isolate_get_input_r(), RENDER_QUANTUM);
    this.outL = new Float32Array(buf, this.exports.isolate_get_output_l(), RENDER_QUANTUM);
    this.outR = new Float32Array(buf, this.exports.isolate_get_output_r(), RENDER_QUANTUM);
    this.frameView = new Float32Array(buf, this.exports.chroma_get_frame_ptr(), FRAME_FLOATS);
    this.eventView = new Float32Array(buf, this.exports.chroma_get_event_ptr(), EVENT_FLOATS);

    this.ready = true;
    this.port.postMessage({
      type: "WORKLET_READY",
      sampleRate: this.sampleRateValue,
      latencySamples: this.exports.isolate_latency_samples(),
    });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    // Pass through while the WASM loads, so the tab is never silent.
    if (!this.ready) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].set(input[Math.min(ch, input.length - 1)]);
      }
      return true;
    }

    const n = input[0].length;
    this.inL.set(input[0]);
    this.inR.set(input.length > 1 ? input[1] : input[0]);

    this.exports.isolate_process(n);

    output[0].set(this.outL);
    if (output.length > 1) output[1].set(this.outR);

    // Must follow isolate_process: chroma reads its delay-matched dry and wet
    // buffers, which only hold this block afterwards.
    if (this.chromaOn) {
      this.exports.chroma_feed(n);
      if (++this.drainCounter >= DRAIN_EVERY) {
        this.drainCounter = 0;
        this._drainChroma();
      }
    }

    return true;
  }

  _drainChroma() {
    // Copied out of the WASM staging buffer before the next pop overwrites it.
    let frames = null;
    let count = 0;
    while (this.exports.chroma_pop_frame()) {
      if (!frames) frames = new Float32Array(FRAME_FLOATS * 64);
      if (count >= 64) break;              // ring is 96; 64 per message is ample
      frames.set(this.frameView, count * FRAME_FLOATS);
      count++;
    }

    let events = null;
    while (this.exports.chroma_pop_event()) {
      if (!events) events = [];
      const e = this.eventView;
      events.push({
        t: e[0],
        root: e[1] < 0 ? -1 : e[1] | 0,
        quality: e[2] < 0 ? -1 : e[2] | 0,
        conf: e[3],
      });
    }

    if (count > 0) {
      const slice = frames.subarray(0, count * FRAME_FLOATS);
      // Transferred, not copied — the buffer is rebuilt next drain anyway.
      const copy = new Float32Array(slice);
      this.port.postMessage(
        { type: "CHROMA_FRAMES", count, floats: FRAME_FLOATS, data: copy.buffer },
        [copy.buffer]
      );
    }
    if (events) {
      this.port.postMessage({ type: "CHORD_EVENTS", events, tuning: this.exports.chroma_get_tuning() });
    }
  }
}

function modeId(name) {
  const id = MODE_IDS[name];
  return id === undefined ? MODE_IDS.vocal_rhythm : id;
}

registerProcessor("vocal-isolate-processor", VocalIsolateProcessor);
