/*
 * Instrufilt — chord detection, public interface.
 *
 * Runs alongside the isolation STFT but with its own, longer analysis. At 48 kHz
 * the isolation FFT has 23.4 Hz bins, which only resolves a semitone above
 * ~393 Hz — most chords are voiced below that, so its spectrum is unusable for
 * pitch. This stage uses an 8192-point FFT (5.9 Hz bins, semitone-resolvable
 * down to ~110 Hz) at a 2048 hop.
 *
 * The decoder here is deliberately causal and dumb: per-frame template matching
 * plus hysteresis. The good decode is a Viterbi pass in JS over the streamed
 * chroma (shared/chord-decode.js), which keeps the audio thread cheap and puts
 * the part most likely to need iteration somewhere it can be changed without
 * emscripten in the loop.
 */
#ifndef INSTRUFILT_CHROMA_H
#define INSTRUFILT_CHROMA_H

/* Floats per exported frame: t, tuning, chroma[12], bass[12], energy, flux. */
#define CHROMA_FRAME_FLOATS 28
/* Floats per exported event: t, root, quality, confidence, bass, spare. */
#define CHROMA_EVENT_FLOATS 6

enum {
    CHORD_MAJ = 0,
    CHORD_MIN = 1,
    CHORD_NONE = -1,
};

void  chroma_init(int sample_rate);
void  chroma_cleanup(void);

/* Off by default. While disabled, feed() is a cheap no-op — the panel does not
 * need chords when it is closed, and an ad or a paused tab must not write
 * garbage into a chart. */
void  chroma_enable(int on);
int   chroma_is_enabled(void);

/* Drop all analysis state. Called on a song change and after a seek: the
 * rolling window would otherwise straddle two unrelated pieces of music. */
void  chroma_reset(void);

/* Consume `num_samples` from the isolation stage's dry and wet buffers, which
 * must already hold this block (call isolate_process first).
 *
 * Analyses `dry_delayed - RESIDUAL_MIX * wet`: the instrumental residual. The
 * mix is contaminated by the lead vocal — loud, monophonic, bending, and landing
 * on non-chord tones — which actively steers the chroma wrong. Subtracting the
 * isolated vocal removes most of that while leaving centred piano and rhythm
 * guitar largely intact. chroma_test.c asserts this beats analysing the mix,
 * rather than assuming it. */
void  chroma_feed(int num_samples);

/* Ring drains. Each returns 1 and stages a record at the matching *_ptr, or 0
 * when the ring is empty. The worklet drains both every ~32 render quanta and
 * batches them into one message. */
int   chroma_pop_frame(void);
float *chroma_get_frame_ptr(void);
int   chroma_pop_event(void);
float *chroma_get_event_ptr(void);

/* Estimated tuning offset in semitones, -0.5..0.5. Non-zero far more often than
 * you would expect: a large share of YouTube uploads are pitch-shifted a few
 * percent to dodge Content ID. Meaningless before ~3 s of audio. */
float chroma_get_tuning(void);

/* Frames analysed since the last reset. */
int   chroma_frame_count(void);

/* --- test hooks (not exported to WASM) --------------------------------- */

/* Feed a stereo block directly, bypassing the isolation stage, so chroma can be
 * tested on synthesised audio without running the DSP. */
void  chroma_feed_raw(const float *l, const float *r, int num_samples);

/* 0 = analyse the mix, 1 = full residual. Default 0.8. chroma_test.c sweeps
 * this to prove the residual choice is worth its complexity. */
void  chroma_set_residual_mix(float mix);

/* Most recent per-frame decision, for tests that do not want to drain rings. */
int   chroma_current_chord(void);
float chroma_current_confidence(void);

#endif /* INSTRUFILT_CHROMA_H */
