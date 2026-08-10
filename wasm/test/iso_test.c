/*
 * Instrufilt DSP assertions — native, no emscripten needed.
 *
 *   make test-native
 *
 * or by hand:
 *   gcc -O2 -I wasm/src wasm/test/iso_test.c wasm/src/vocal_isolate_stft.c \
 *       wasm/src/kiss_fft.c wasm/src/kiss_fftr.c -lm -o /tmp/iso_test && /tmp/iso_test
 *
 * Forked from Karafilt's wasm/test/dsp_test.c. Its assertions invert cleanly:
 * where it asserts a centred tone is ATTENUATED and a hard-panned one SURVIVES,
 * we assert the opposite. Four of these exist specifically to catch the traps
 * documented at the top of vocal_isolate_stft.c — they are marked TRAP n, and
 * a naive inversion of Karafilt's loop fails every one of them.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "isolate.h"

#define BLOCK 128
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static int failures = 0;
static int checks = 0;

static void check(const char *name, int ok, const char *fmt, ...) {
    checks++;
    if (ok) {
        printf("  \x1b[32mok\x1b[0m   %s\n", name);
        return;
    }
    failures++;
    printf("  \x1b[31mFAIL\x1b[0m %s\n", name);
    if (fmt && *fmt) {
        va_list ap;
        __builtin_va_start(ap, fmt);
        printf("       ");
        vprintf(fmt, ap);
        printf("\n");
        __builtin_va_end(ap);
    }
}

/* ------------------------------------------------------------- signals */

typedef struct { float *l, *r; int n; } sig_t;

static sig_t sig_alloc(int n) {
    sig_t s = { calloc(n, sizeof(float)), calloc(n, sizeof(float)), n };
    return s;
}
static void sig_free(sig_t *s) { free(s->l); free(s->r); s->l = s->r = NULL; }

/* pan: 0 = centred (identical L/R), 1 = hard left, -1 = hard right */
static void add_tone(sig_t *s, float sr, float hz, float amp, float pan) {
    float gl = (pan >= 0.0f) ? 1.0f : 1.0f + pan;
    float gr = (pan <= 0.0f) ? 1.0f : 1.0f - pan;
    for (int i = 0; i < s->n; i++) {
        float v = amp * sinf(2.0f * (float)M_PI * hz * (float)i / sr);
        s->l[i] += v * gl;
        s->r[i] += v * gr;
    }
}

static unsigned rng_state = 12345u;
static float frand(void) {
    rng_state = rng_state * 1103515245u + 12345u;
    return ((float)((rng_state >> 16) & 0x7fff) / 16383.5f) - 1.0f;
}

static void add_noise(sig_t *s, float amp, float pan) {
    float gl = (pan >= 0.0f) ? 1.0f : 1.0f + pan;
    float gr = (pan <= 0.0f) ? 1.0f : 1.0f - pan;
    for (int i = 0; i < s->n; i++) {
        float a = frand() * amp, b = frand() * amp;
        /* pan==0 means correlated (centred); otherwise independent per side */
        s->l[i] += (pan == 0.0f ? a : a) * gl;
        s->r[i] += (pan == 0.0f ? a : b) * gr;
    }
}

/* Run a signal through the module, returning its output. */
static sig_t run(sig_t in) {
    sig_t out = sig_alloc(in.n);
    float *il = isolate_get_input_l(), *ir = isolate_get_input_r();
    float *ol = isolate_get_output_l(), *or_ = isolate_get_output_r();
    for (int off = 0; off + BLOCK <= in.n; off += BLOCK) {
        memcpy(il, in.l + off, BLOCK * sizeof(float));
        memcpy(ir, in.r + off, BLOCK * sizeof(float));
        isolate_process(BLOCK);
        memcpy(out.l + off, ol, BLOCK * sizeof(float));
        memcpy(out.r + off, or_, BLOCK * sizeof(float));
    }
    return out;
}

/* RMS over the settled region — skip the leading latency plus a margin for
 * the mask smoother to converge. */
static float rms_tail(const float *x, int n, int skip) {
    double s = 0.0;
    int cnt = 0;
    for (int i = skip; i < n; i++) { s += (double)x[i] * x[i]; cnt++; }
    return cnt ? (float)sqrt(s / cnt) : 0.0f;
}

/* Energy of `x` at frequency hz, via a single-bin Goertzel-style projection. */
static float band_energy(const float *x, int n, int start, int len, float sr, float hz) {
    double re = 0.0, im = 0.0;
    for (int i = 0; i < len; i++) {
        double t = 2.0 * M_PI * hz * (double)(start + i) / sr;
        re += x[start + i] * cos(t);
        im += x[start + i] * sin(t);
    }
    return (float)(2.0 * sqrt(re * re + im * im) / len);
}

/* Every test below runs with the REPET stage OFF unless it opts back in.
 * These assertions are about the pan mask, and REPET would confound them: it
 * suppresses anything that recurs, and a steady test tone is the most
 * repetitive signal there is. t_repet() is the one test that turns it on, and
 * it measures against this same baseline. */
static void reset(float sr, int mode) {
    isolate_set_mask_bypass(0);
    isolate_set_smoothing_tau(-1.0f, -1.0f);
    isolate_set_repet(0.0f);
    isolate_set_mode(mode);
    isolate_set_auto_gain(0);
    isolate_set_makeup_db(0.0f);
    isolate_set_amount(1.0f);
    isolate_set_mono(0);
    isolate_init((int)sr);
    isolate_set_makeup_db(0.0f);   /* init reapplies the mode's makeup */
}

#define LAT 2048
#define SETTLE (LAT + 8192)

/* ------------------------------------------------------------- the tests */

/* 1. amount == 0 is a bit-exact passthrough of the input delayed by exactly
 *    FFT_SIZE. Stronger than Karafilt's dsp_test.c:102-111, which only checks
 *    its time-domain path. This is the assertion that makes the isolation
 *    slider trustworthy as an A/B. */
static void t_passthrough(float sr) {
    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_amount(0.0f);

    int n = 16384;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 440.0f, 0.4f, 0.0f);
    add_tone(&in, sr, 3100.0f, 0.2f, 1.0f);
    add_noise(&in, 0.05f, -1.0f);
    sig_t out = run(in);

    float worst = 0.0f;
    int worst_i = -1;
    for (int i = LAT; i < n; i++) {
        float d = fabsf(out.l[i] - in.l[i - LAT]);
        float e = fabsf(out.r[i] - in.r[i - LAT]);
        if (d > worst) { worst = d; worst_i = i; }
        if (e > worst) { worst = e; worst_i = i; }
    }
    check("amount=0 is bit-exact passthrough delayed by 2048", worst == 0.0f,
          "max deviation %.3e at sample %d (expected exactly 0)", worst, worst_i);
    sig_free(&in); sig_free(&out);
}

/* 2. A centred tone in the vocal band SURVIVES.
 *    Inverts dsp_test.c:122-127 ("centered tone attenuated"). */
static void t_centred_survives(float sr) {
    reset(sr, ISO_MODE_VOCAL_ONLY);
    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 1000.0f, 0.5f, 0.0f);
    sig_t out = run(in);

    float ein = band_energy(in.l, n, SETTLE, n - SETTLE, sr, 1000.0f);
    float eout = band_energy(out.l, n, SETTLE, n - SETTLE, sr, 1000.0f);
    float ratio = eout / (ein + 1e-12f);
    check("centred 1kHz preserved (ratio > 0.8)", ratio > 0.8f,
          "ratio %.3f (in %.4f -> out %.4f)", ratio, ein, eout);
    sig_free(&in); sig_free(&out);
}

/* 3. A hard-panned tone in the vocal band is REMOVED.
 *    Inverts dsp_test.c:130-138 ("hard-panned tone preserved"). */
static void t_panned_removed(float sr) {
    reset(sr, ISO_MODE_VOCAL_ONLY);
    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 1000.0f, 0.5f, 1.0f);   /* left only */
    sig_t out = run(in);

    float ein = band_energy(in.l, n, SETTLE, n - SETTLE, sr, 1000.0f);
    float eout = band_energy(out.l, n, SETTLE, n - SETTLE, sr, 1000.0f);
    float ratio = eout / (ein + 1e-12f);
    check("hard-panned 1kHz removed (ratio < 0.15)", ratio < 0.15f,
          "ratio %.3f (in %.4f -> out %.4f)", ratio, ein, eout);
    sig_free(&in); sig_free(&out);
}

/* 4. TRAP 1 — a centred 60 Hz tone is REMOVED in VOCAL_ONLY.
 *    Inverts dsp_test.c:149-157 ("bass preserved"). This is THE assertion that
 *    catches the `continue` trap: with Karafilt's `if (fw <= 0) continue;` the
 *    bin passes through untouched and this reads ~1.0 instead of ~0. */
static void t_trap1_bass_removed(float sr) {
    reset(sr, ISO_MODE_VOCAL_ONLY);
    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 60.0f, 0.5f, 0.0f);
    sig_t out = run(in);

    float ein = band_energy(in.l, n, SETTLE, n - SETTLE, sr, 60.0f);
    float eout = band_energy(out.l, n, SETTLE, n - SETTLE, sr, 60.0f);
    float ratio = eout / (ein + 1e-12f);
    check("TRAP 1: centred 60Hz removed in VOCAL_ONLY (ratio < 0.15)", ratio < 0.15f,
          "ratio %.3f — out-of-band bins are being passed through, not zeroed", ratio);
    sig_free(&in); sig_free(&out);
}

/* 5. The same 60 Hz tone SURVIVES in VOCAL_RHYTHM. Proves the mode table
 *    actually does something, and that "vocal + rhythm" really is the same
 *    code path with different band edges. */
static void t_rhythm_keeps_bass(float sr) {
    reset(sr, ISO_MODE_VOCAL_RHYTHM);
    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 60.0f, 0.5f, 0.0f);
    sig_t out = run(in);

    float ein = band_energy(in.l, n, SETTLE, n - SETTLE, sr, 60.0f);
    float eout = band_energy(out.l, n, SETTLE, n - SETTLE, sr, 60.0f);
    float ratio = eout / (ein + 1e-12f);
    check("centred 60Hz preserved in VOCAL_RHYTHM (ratio > 0.7)", ratio > 0.7f,
          "ratio %.3f", ratio);
    sig_free(&in); sig_free(&out);
}

/* 6. TRAP 3 — with the mask bypassed, reconstruction gain is UNITY.
 *    Replaces dsp_test.c:168-178, which asserts 1.4 < gain < 1.6 and calls it
 *    "expect ~1.5 OLA gain" — i.e. it pins the bug in place. */
static void t_trap3_ola_gain(float sr) {
    reset(sr, ISO_MODE_VOCAL_RHYTHM);
    isolate_set_mask_bypass(1);

    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 700.0f, 0.4f, 0.0f);
    add_tone(&in, sr, 2300.0f, 0.3f, 0.6f);
    sig_t out = run(in);

    float gin = rms_tail(in.l, n, SETTLE);
    float gout = rms_tail(out.l, n, SETTLE);
    float gain = gout / (gin + 1e-12f);
    check("TRAP 3: OLA reconstruction gain is unity (0.98-1.02)",
          gain > 0.98f && gain < 1.02f,
          "gain %.4f — Karafilt ships 1.5 here (+3.5 dB)", gain);
    sig_free(&in); sig_free(&out);
}

/* 6b. Perfect reconstruction. This is what licenses chroma.c's
 *     `residual = dry_delayed - wet` identity — without it the residual is an
 *     approximation and the chord input is quietly wrong. */
static void t_perfect_reconstruction(float sr) {
    reset(sr, ISO_MODE_VOCAL_RHYTHM);
    isolate_set_mask_bypass(1);

    int n = 32768;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 440.0f, 0.3f, 0.0f);
    add_tone(&in, sr, 1750.0f, 0.25f, -0.8f);
    add_noise(&in, 0.05f, 1.0f);

    float *il = isolate_get_input_l(), *ir = isolate_get_input_r();
    float *wl = isolate_get_wet_l(), *dl = isolate_get_dry_l();
    float worst = 0.0f;
    for (int off = 0; off + BLOCK <= n; off += BLOCK) {
        memcpy(il, in.l + off, BLOCK * sizeof(float));
        memcpy(ir, in.r + off, BLOCK * sizeof(float));
        isolate_process(BLOCK);
        if (off < SETTLE) continue;
        for (int i = 0; i < BLOCK; i++) {
            float d = fabsf(dl[i] - wl[i]);
            if (d > worst) worst = d;
        }
    }
    check("mask bypassed: |dry_delayed - wet| < 1e-5 (perfect reconstruction)",
          worst < 1e-5f, "max |dry - wet| = %.3e", worst);
    sig_free(&in);
}

/* 7. TRAP 1 (DC case) — a DC offset must not survive to the output. */
static void t_trap1_dc(float sr) {
    reset(sr, ISO_MODE_VOCAL_RHYTHM);
    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 900.0f, 0.3f, 0.0f);
    for (int i = 0; i < n; i++) { in.l[i] += 0.5f; in.r[i] += 0.5f; }
    sig_t out = run(in);

    double s = 0.0;
    int cnt = 0;
    for (int i = SETTLE; i < n; i++) { s += out.l[i]; cnt++; }
    float dc = (float)fabs(s / cnt);
    check("TRAP 1: DC offset removed (|mean| < 1e-3)", dc < 1e-3f,
          "output DC mean %.5f — k=0 is not being zeroed", dc);
    sig_free(&in); sig_free(&out);
}

/* 8. TRAP 2 — musical noise.
 *
 *    A quiet centred tone buried in loud hard-panned noise is the worst case
 *    for a pan-based mask: the mask flickers open and shut frame to frame, and
 *    with no instrumental left to hide under, that flutter IS the output.
 *
 *    Measured as the coefficient of variation of TOTAL output RMS across 20 ms
 *    windows. Total, not per-band: musical noise is broadband warbling across
 *    many bins at once, so a single-band probe misses most of it and separates
 *    smoothed from unsmoothed by only ~1.1x. On total RMS the separation is a
 *    consistent ~1.8x at every sample rate.
 *
 *    The NEGATIVE CONTROL is what makes this meaningful: the same run with
 *    smoothing disabled must fail the bound the smoothed run passes. Without
 *    it the test would still pass if the smoother were accidentally a no-op. */
static float flutter_cov(float sr, int smoothing) {
    reset(sr, ISO_MODE_VOCAL_ONLY);
    if (!smoothing) isolate_set_smoothing_tau(0.0f, 0.0f);

    /* Length and windows are expressed in TIME, not samples. With fixed sample
     * counts, a 1024-sample window is 21 ms at 48k but 10.7 ms at 96k, so the
     * three rates would be measuring different physical things and the
     * comparison across them would be meaningless. */
    int n = (int)(sr * 2.5f) & ~(BLOCK - 1);
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 1000.0f, 0.01f, 0.0f);   /* -40 dB centred */
    add_noise(&in, 0.1f, 1.0f);                /* -20 dB hard left */
    add_noise(&in, 0.1f, -1.0f);
    sig_t out = run(in);

    const int W = (int)(sr / 50.0f);           /* 20 ms */
    int settle = LAT + (int)(sr * 0.5f);
    double vals[256];
    int nv = 0;
    for (int off = settle; off + W <= n && nv < 256; off += W) {
        double s = 0.0;
        for (int i = 0; i < W; i++) s += (double)out.l[off + i] * out.l[off + i];
        vals[nv++] = sqrt(s / W);
    }

    double mean = 0.0;
    for (int i = 0; i < nv; i++) mean += vals[i];
    mean /= nv;
    double var = 0.0;
    for (int i = 0; i < nv; i++) var += (vals[i] - mean) * (vals[i] - mean);
    var /= nv;

    sig_free(&in); sig_free(&out);
    return (mean > 1e-12) ? (float)(sqrt(var) / mean) : 999.0f;
}

static void t_trap2_musical_noise(float sr) {
    float with_sm = flutter_cov(sr, 1);
    float without = flutter_cov(sr, 0);

    check("TRAP 2: output flutter bounded with smoothing (CoV < 0.08)",
          with_sm < 0.08f, "CoV %.4f", with_sm);
    check("TRAP 2: negative control — unsmoothed exceeds that bound",
          without > 0.08f, "unsmoothed CoV %.4f — the smoother is a no-op", without);
    check("TRAP 2: smoothing cuts flutter by at least 1.5x",
          without > with_sm * 1.5f,
          "smoothed %.4f vs unsmoothed %.4f (%.2fx)",
          with_sm, without, without / (with_sm + 1e-9f));
}

/* 9. No NaN or Inf on pathological input. Extends dsp_test.c:166. */
static void t_no_nan(float sr) {
    const char *names[] = { "silence", "full-scale square", "DC", "alternating +/-1", "impulse" };
    for (int variant = 0; variant < 5; variant++) {
        reset(sr, ISO_MODE_VOCAL_ONLY);
        int n = 32768;
        sig_t in = sig_alloc(n);
        for (int i = 0; i < n; i++) {
            float v = 0.0f;
            switch (variant) {
                case 0: v = 0.0f; break;
                case 1: v = ((i / 64) % 2) ? 1.0f : -1.0f; break;
                case 2: v = 1.0f; break;
                case 3: v = (i % 2) ? 1.0f : -1.0f; break;
                case 4: v = (i == 4096) ? 1.0f : 0.0f; break;
            }
            in.l[i] = in.r[i] = v;
        }
        sig_t out = run(in);
        int bad = 0;
        for (int i = 0; i < n; i++)
            if (!isfinite(out.l[i]) || !isfinite(out.r[i])) { bad = i; break; }
        char label[96];
        snprintf(label, sizeof label, "no NaN/Inf: %s", names[variant]);
        check(label, bad == 0, "non-finite output at sample %d", bad);
        sig_free(&in); sig_free(&out);
    }
}

/* 10. Gain staging: the ceiling always holds, and the knee is soft where
 *     softness actually matters.
 *
 *     Two separate claims, deliberately not merged. At 8x overdrive a limiter
 *     SHOULD flat-top — that is what limiting is, and asserting otherwise would
 *     only be satisfiable by a limiter that fails to limit. What must not
 *     happen is hard clipping just past the knee, where ordinary loud passages
 *     live; that is the difference between musical compression and buzz. */
static void t_gain_staging(float sr) {
    /* (a) extreme drive: the ceiling holds, no matter what. */
    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_makeup_db(18.0f);
    int n = 65536;
    sig_t in = sig_alloc(n);
    add_tone(&in, sr, 1000.0f, 1.0f, 0.0f);
    sig_t out = run(in);

    int over = 0;
    float peak = 0.0f;
    for (int i = 0; i < n; i++) {
        float a = fabsf(out.l[i]);
        if (a > 1.0f) over++;
        if (a > peak) peak = a;
    }
    check("+18dB into full scale never exceeds 1.0", over == 0,
          "%d samples over full scale (peak %.5f)", over, peak);
    sig_free(&in); sig_free(&out);

    /* (b) just past the knee: still curved, not flat-topped. A hard clipper
     *     would park many consecutive samples at the ceiling here. */
    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_makeup_db(1.5f);          /* ~1.19x — a shade into the knee */
    in = sig_alloc(n);
    add_tone(&in, sr, 1000.0f, 0.9f, 0.0f);
    out = run(in);

    peak = 0.0f;
    for (int i = SETTLE; i < n; i++) {
        float a = fabsf(out.l[i]);
        if (a > peak) peak = a;
    }
    int run_len = 0, worst_run = 0;
    for (int i = SETTLE; i < n; i++) {
        if (fabsf(out.l[i]) >= peak * 0.999f) {
            run_len++;
            if (run_len > worst_run) worst_run = run_len;
        } else run_len = 0;
    }
    check("just past the knee: soft, not flat-topped (run <= 3)", worst_run <= 3,
          "%d consecutive samples within 0.1%% of peak %.4f — this is clipping",
          worst_run, peak);
    sig_free(&in); sig_free(&out);
}

/* 12. TRAP 5 — REPET separates two sources that centerness cannot.
 *
 *     Both sources here are CENTRED and both sit inside VOCAL_ONLY's pass band,
 *     so band_weight and centerness score them identically. Nothing in the pan
 *     mask can tell them apart. The only difference is that one repeats on an
 *     exact 2 s loop and the other does not.
 *
 *     Measured against the SAME signal through the SAME mode with the stage
 *     disabled, so the ratios isolate REPET from every other term. That control
 *     is what makes the numbers mean anything: a mask that simply attenuated
 *     everything would move both ratios together and fail the third assertion.
 */

/* Three earlier revisions of this signal failed, and all three failures were
 * the test being wrong rather than the stage — worth recording, because each
 * only looks wrong once you think in BANDS over TIME rather than in Hz:
 *
 *   - Four pitches inside 1400-1850 Hz are less than one band apart, so in the
 *     band domain the "melody" was one stationary source.
 *   - Notes butted end to end with no rests made it a continuous drone.
 *   - Any melody drawn from a DISCRETE pitch set is exactly repetitive: every
 *     note is a literal repeat of an earlier note, so the similarity search
 *     finds twelve frames at that same pitch and the median suppresses it. Real
 *     singing never lands on precisely the same spectrum twice, so the pitch
 *     here is drawn continuously and carries vibrato.
 *
 * The background got the opposite correction. It was silent half of every loop,
 * and during those gaps the frame vector was pure lead — so the search matched
 * on the lead and, correctly, called it repetitive. Real backing plays
 * continuously, which is what keeps the similarity driven by the band. */
static const float BG_HZ[2] = { 400.0f, 600.0f };
static const float BG_SUS   = 220.0f;   /* sustained through the whole loop */
static const float VOX_LO   = 800.0f;
static const float VOX_HI   = 3000.0f;

/* Raised-cosine edges on every segment. Hard gating would put a broadband click
 * at each boundary, which the transient penalty and the `hit` attack freeze
 * would then act on — muddying a test that is supposed to vary one thing. */
static float seg_env(int j, int len, float sr) {
    int f = (int)(sr * 0.01f);          /* 10 ms */
    if (f > len / 2) f = len / 2;
    if (f < 1) return 1.0f;
    if (j < f)        return 0.5f * (1.0f - cosf((float)M_PI * (float)j / (float)f));
    if (j >= len - f) return 0.5f * (1.0f - cosf((float)M_PI * (float)(len - 1 - j) / (float)f));
    return 1.0f;
}

/* Builds the two sources SEPARATELY so each can be projected back out of the
 * output independently — see project(). The mix is bg + vox. */
static void build_repet_signal(sig_t *bg, sig_t *vox, float sr) {
    /* The "band": a sustained tone under a two-chord riff, on an exact 2 s loop
     * with no gaps. Centred. */
    const int PN   = (int)(sr * 2.0f);
    const int HALF = PN / 2;
    for (int i = 0; i < bg->n; i++) {
        int ph = i % PN;
        float v = 0.30f * sinf(2.0f * (float)M_PI * BG_SUS * (float)i / sr);
        float hz = (ph < HALF) ? BG_HZ[0] : BG_HZ[1];
        int j = (ph < HALF) ? ph : (ph - HALF);
        v += 0.42f * seg_env(j, HALF, sr)
           * sinf(2.0f * (float)M_PI * hz * (float)i / sr);
        bg->l[i] += v;
        bg->r[i] += v;
    }

    /* The "singer": note boundaries, rests and pitches all aperiodic, the pitch
     * drawn CONTINUOUSLY rather than from a set, and 3% vibrato at 5.5 Hz on
     * top. No past frame is ever an exact match for the present one. Centred,
     * exactly like the riff — centerness cannot tell these two apart, which is
     * the whole point. */
    rng_state = 987654321u;
    int i = 0;
    float phase = 0.0f;
    while (i < vox->n) {
        int len  = (int)(sr * (0.20f + 0.25f * (frand() * 0.5f + 0.5f)));
        int rest = (int)(sr * (0.08f + 0.20f * (frand() * 0.5f + 0.5f)));
        float hz = VOX_LO + (VOX_HI - VOX_LO) * (frand() * 0.5f + 0.5f);
        if (len < 1) len = 1;
        int end = i + len;
        if (end > vox->n) end = vox->n;
        for (int j = 0; i < end; i++, j++) {
            float vib = 1.0f + 0.03f * sinf(2.0f * (float)M_PI * 5.5f * (float)j / sr);
            float v = 0.38f * seg_env(j, len, sr) * sinf(phase);
            phase += 2.0f * (float)M_PI * hz * vib / sr;
            if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
            vox->l[i] += v;
            vox->r[i] += v;
        }
        i += rest;
    }
}

/* Gain applied to `ref` inside the output, by least-squares projection.
 *
 * Replaces a per-frequency Goertzel sweep: it captures every pitch of the
 * melody in one pass with no trig at all, and it reports an absolute gain
 * rather than only a ratio. `ref` is read delayed by LAT because the STFT path
 * is — projecting against the undelayed source measures the group delay, not
 * the mask. The two sources occupy disjoint frequency regions, so their
 * cross-projection is negligible. */
static float project(const float *out, const float *ref, int start, int len) {
    double num = 0.0, den = 0.0;
    for (int i = start; i < start + len; i++) {
        double r = ref[i - LAT];
        num += (double)out[i] * r;
        den += r * r;
    }
    return (den > 0.0) ? (float)(num / den) : 0.0f;
}

static void t_repet(float sr) {
    int n = (int)(sr * 14.0f) & ~(BLOCK - 1);
    sig_t bg = sig_alloc(n), vox = sig_alloc(n), in = sig_alloc(n);
    build_repet_signal(&bg, &vox, sr);
    for (int i = 0; i < n; i++) {
        in.l[i] = bg.l[i] + vox.l[i];
        in.r[i] = bg.r[i] + vox.r[i];
    }

    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_repet(0.0f);
    sig_t off = run(in);

    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_repet(1.0f);
    sig_t on = run(in);

    /* From 6 s: the stage needs ~2 s of history to engage and fades in over the
     * next ~1 s, so everything measured here is fully engaged. */
    int start = (int)(sr * 6.0f);
    int len = n - start;

    float bg_off = project(off.l, bg.l, start, len);
    float bg_on  = project(on.l,  bg.l, start, len);
    float vx_off = project(off.l, vox.l, start, len);
    float vx_on  = project(on.l,  vox.l, start, len);

    float bg_ratio = bg_on / (bg_off + 1e-12f);
    float vx_ratio = vx_on / (vx_off + 1e-12f);

    /* Printed unconditionally. The thresholds below are deliberately loose and
     * these are the numbers that actually say whether a change to the stage
     * helped: the assertions only catch a regression past the point of being
     * broken. */
    printf("       lead %.3fx  background %.3fx  separation %.1fx\n",
           vx_ratio, bg_ratio, vx_ratio / (bg_ratio + 1e-9f));

    check("TRAP 5: repeating centred background suppressed (< 0.15x)",
          bg_ratio < 0.15f,
          "background %.3fx vs stage-off (%.3f -> %.3f) — centred repetition is "
          "surviving", bg_ratio, bg_off, bg_on);
    check("TRAP 5: aperiodic centred lead preserved (> 0.85x)",
          vx_ratio > 0.85f,
          "lead %.3fx vs stage-off (%.3f -> %.3f) — REPET is eating the thing it "
          "exists to keep", vx_ratio, vx_off, vx_on);
    check("TRAP 5: separation is at least 4x",
          vx_ratio > bg_ratio * 4.0f,
          "lead %.3fx vs background %.3fx (%.2fx) — this is broadband attenuation, "
          "not separation", vx_ratio, bg_ratio, vx_ratio / (bg_ratio + 1e-9f));

    int bad = -1;
    for (int i = 0; i < n; i++)
        if (!isfinite(on.l[i]) || !isfinite(on.r[i])) { bad = i; break; }
    check("TRAP 5: no NaN/Inf with the stage engaged", bad < 0,
          "non-finite output at sample %d", bad);

    sig_free(&bg); sig_free(&vox); sig_free(&in); sig_free(&off); sig_free(&on);
}

/* 13. The history must not survive a discontinuity. After a reset the stage is
 *     back in warm-up, so the first seconds of the new material are passed
 *     through unsuppressed rather than masked against a median taken across the
 *     splice. Asserted by comparing a warmed-up run to one reset just before
 *     the measurement window. */
static void t_repet_reset(float sr) {
    int n = (int)(sr * 14.0f) & ~(BLOCK - 1);
    sig_t bg = sig_alloc(n), vox = sig_alloc(n), in = sig_alloc(n);
    build_repet_signal(&bg, &vox, sr);
    for (int i = 0; i < n; i++) {
        in.l[i] = bg.l[i] + vox.l[i];
        in.r[i] = bg.r[i] + vox.r[i];
    }

    /* Only the 2 s immediately after the reset: the warm run is fully engaged
     * throughout it and the reset run is still in warm-up throughout it, so the
     * two are being compared where they should differ most. */
    int start = (int)(sr * 6.0f);
    int len = (int)(sr * 2.0f);

    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_repet(1.0f);
    sig_t warm = run(in);

    /* Same input, but the history is dropped just before the window opens. */
    reset(sr, ISO_MODE_VOCAL_ONLY);
    isolate_set_repet(1.0f);
    sig_t cold = sig_alloc(n);
    {
        float *il = isolate_get_input_l(), *ir = isolate_get_input_r();
        float *ol = isolate_get_output_l(), *or_ = isolate_get_output_r();
        for (int off = 0; off + BLOCK <= n; off += BLOCK) {
            if (off == (start & ~(BLOCK - 1))) isolate_repet_reset();
            memcpy(il, in.l + off, BLOCK * sizeof(float));
            memcpy(ir, in.r + off, BLOCK * sizeof(float));
            isolate_process(BLOCK);
            memcpy(cold.l + off, ol, BLOCK * sizeof(float));
            memcpy(cold.r + off, or_, BLOCK * sizeof(float));
        }
    }

    float bg_warm = project(warm.l, bg.l, start, len);
    float bg_cold = project(cold.l, bg.l, start, len);
    check("isolate_repet_reset() drops the history (background returns)",
          bg_cold > bg_warm * 1.3f,
          "reset %.4f vs warmed %.4f — the ring survived the reset", bg_cold, bg_warm);

    sig_free(&bg); sig_free(&vox); sig_free(&in); sig_free(&warm); sig_free(&cold);
}

/* ----------------------------------------------------------------- main */

int main(void) {
    /* 11. The whole suite runs at three sample rates. Coefficients baked for
     *     48k would pass everything here at 48k and fail the flutter bound at
     *     96k — on exactly the machines least likely to report it. Karafilt
     *     has no sample-rate test at all. */
    const float RATES[] = { 44100.0f, 48000.0f, 96000.0f };

    for (int r = 0; r < 3; r++) {
        float sr = RATES[r];
        printf("\n\x1b[1m%.0f Hz\x1b[0m\n", sr);
        t_passthrough(sr);
        t_centred_survives(sr);
        t_panned_removed(sr);
        t_trap1_bass_removed(sr);
        t_rhythm_keeps_bass(sr);
        t_trap3_ola_gain(sr);
        t_perfect_reconstruction(sr);
        t_trap1_dc(sr);
        t_trap2_musical_noise(sr);
        t_no_nan(sr);
        t_gain_staging(sr);
        t_repet(sr);
        t_repet_reset(sr);
    }

    isolate_cleanup();

    printf("\n");
    if (failures) {
        printf("\x1b[31m%d/%d assertions failed\x1b[0m\n", failures, checks);
        return 1;
    }
    printf("\x1b[32m%d/%d assertions passed\x1b[0m\n", checks, checks);
    return 0;
}
