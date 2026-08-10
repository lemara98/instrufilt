/*
 * Instrufilt — lead-vocal isolation, public interface.
 *
 * Buffers are flat float arrays owned by the module, not structs: nothing about
 * layout has to be agreed across the WASM boundary, and the worklet just reads
 * N floats from a pointer.
 */
#ifndef INSTRUFILT_ISOLATE_H
#define INSTRUFILT_ISOLATE_H

enum {
    ISO_MODE_VOCAL_ONLY   = 0,  /* singer, high-passed clear of the rhythm section */
    ISO_MODE_VOCAL_RHYTHM = 1,  /* + centred kick/bass/snare — the default         */
    ISO_MODE_LEAD_LINE    = 2,  /* narrow formant band, for picking out a melody   */
    ISO_MODE_COUNT        = 3,
};

/* Group delay in samples, = FFT_SIZE. Exposed as a constant as well as through
 * isolate_latency_samples() because chroma.c needs it at compile time to place
 * chord timestamps back on the input timeline. */
#define ISO_LATENCY_SAMPLES 2048

/* Broadband spectral flux of the most recent frame, 0..1. 0 = steady, ->1 = a
 * broadband transient (drum hit). Drives the mask attack freeze, and chroma.c
 * reads it as an onset envelope for beat tracking. */
extern float iso_frame_flux;

void   isolate_init(int sample_rate);
void   isolate_process(int num_samples);
void   isolate_cleanup(void);

float *isolate_get_input_l(void);
float *isolate_get_input_r(void);
float *isolate_get_output_l(void);
float *isolate_get_output_r(void);

/* Pre-blend wet and delay-matched dry. chroma.c analyses dry - 0.8*wet: the
 * instrumental residual, which is a far better chord-detection input than the
 * mix (the lead vocal is loud, monophonic, bends, and lands on non-chord
 * tones, so it actively steers the chroma wrong). */
float *isolate_get_wet_l(void);
float *isolate_get_wet_r(void);
float *isolate_get_dry_l(void);
float *isolate_get_dry_r(void);

void   isolate_set_amount(float amount);     /* 0 = dry passthrough, 1 = fully wet */
void   isolate_set_mode(int mode);           /* ISO_MODE_*                          */
void   isolate_set_makeup_db(float db);      /* wet-path only                       */
void   isolate_set_auto_gain(int on);
void   isolate_set_mono(int on);

/* Online REPET: suppress spectral content that also occurred a bar ago.
 *
 * The second, independent term of the mask. `centerness` is a pan estimator and
 * therefore cannot separate a centred vocal from a centred kick, bass or rhythm
 * guitar; repetition can. Costs no additional latency — the stage only ever
 * looks backwards.
 *
 * 0 disables the stage, 1 applies the full computed suppression, negative
 * restores the current mode's own value (0.85 / 0.00 / 0.95 — it is OFF in
 * VOCAL_RHYTHM, whose entire purpose is keeping the repeating rhythm section).
 * It fades in over ~3 s after a reset while the history fills. */
void   isolate_set_repet(float strength);

/* Drop the REPET history. Must be called on every discontinuity in the audio
 * timeline — seek, track change, ad boundary — or the background estimate is a
 * median taken across a splice. Same trigger set as chroma_reset(). */
void   isolate_repet_reset(void);

float  isolate_get_flux(void);
int    isolate_latency_samples(void);        /* group delay, = FFT_SIZE             */

/* --- test hooks (not exported to WASM) --------------------------------- */

/* Override the mask smoothing time constants. Negative restores the mode's own
 * values. iso_test.c sets both to 0 for the musical-noise negative control:
 * without smoothing the flutter bound MUST fail, which is what makes the
 * positive assertion mean something. */
void   isolate_set_smoothing_tau(float att_tau, float rel_tau);

/* Force keep_mid = keep_side = 1 and skip out-of-band zeroing, making the
 * module a pure STFT analysis/synthesis round trip. Used to assert unity OLA
 * gain (Karafilt ships 1.5) and perfect reconstruction — the latter is what
 * licenses the `residual = dry - wet` identity chroma.c depends on. */
void   isolate_set_mask_bypass(int on);

#endif /* INSTRUFILT_ISOLATE_H */
