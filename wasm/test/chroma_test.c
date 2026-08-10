/*
 * Chord-recognition assertions on synthesised audio.
 *
 *   make test-native
 *
 * Synthetic rather than a corpus, deliberately. A corpus measures how good the
 * detector is; these measure whether it is BROKEN. Clean additive triads with
 * real harmonics are the easiest possible input — anything below ~90% there
 * means the chroma or the templates are wrong, not merely imprecise, and no
 * amount of real-world tuning will fix it.
 *
 * The one experiment rather than assertion is `residual beats mix`: the whole
 * residual design rests on it, so it is checked rather than believed.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "chroma.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define SR    48000
#define BLOCK 512

static int failures = 0, checks = 0;

static void check(const char *name, int ok, const char *fmt, ...) {
    checks++;
    if (ok) { printf("  \x1b[32mok\x1b[0m   %s\n", name); return; }
    failures++;
    printf("  \x1b[31mFAIL\x1b[0m %s\n", name);
    if (fmt && *fmt) {
        va_list ap; __builtin_va_start(ap, fmt);
        printf("       "); vprintf(fmt, ap); printf("\n");
        __builtin_va_end(ap);
    }
}

/* ------------------------------------------------------------- synthesis */

static unsigned rng = 987654321u;
static float frand(void) {
    rng = rng * 1103515245u + 12345u;
    return ((float)((rng >> 16) & 0x7fff) / 16383.5f) - 1.0f;
}

static float midi_hz(float midi, float a4) {
    return a4 * powf(2.0f, (midi - 69.0f) / 12.0f);
}

/* One note with six harmonics rolling off at 1/n — close enough to a piano or
 * a clean guitar that the chroma sees a realistic partial structure rather
 * than an unrealistically clean sinusoid. */
static void add_note(float *buf, int n, float midi, float amp, float a4, int start, int len) {
    float f0 = midi_hz(midi, a4);
    for (int h = 1; h <= 6; h++) {
        float f = f0 * h;
        if (f > SR * 0.45f) break;
        float a = amp / (float)h;
        for (int i = 0; i < len && start + i < n; i++) {
            /* Short attack and release, so frames never straddle a hard edge. */
            float env = 1.0f;
            if (i < 480) env = i / 480.0f;
            else if (i > len - 960) env = (float)(len - i) / 960.0f;
            if (env < 0) env = 0;
            buf[start + i] += a * env * sinf(2.0f * (float)M_PI * f * i / SR);
        }
    }
}

/* root: pitch class 0..11. quality: 0 major, 1 minor. inversion: 0..2.
 * octave: MIDI octave base for the root. */
static void add_triad(float *buf, int n, int root, int quality, int inversion,
                      float octave_base, float amp, float a4, int start, int len) {
    int iv[3] = { 0, quality ? 3 : 4, 7 };
    for (int i = 0; i < 3; i++) {
        int idx = (i + inversion) % 3;
        float midi = octave_base + root + iv[idx] + (idx < inversion ? 12.0f : 0.0f);
        add_note(buf, n, midi, amp, a4, start, len);
    }
    /* Bass note an octave and a half below the root — this is what separates
     * C from Am, and a triad with no bass is not a realistic test. */
    add_note(buf, n, octave_base + root - 24.0f, amp * 1.1f, a4, start, len);
}

static void run(const float *buf, int n) {
    for (int off = 0; off + BLOCK <= n; off += BLOCK) {
        chroma_feed_raw(buf + off, buf + off, BLOCK);
    }
}

static void reset(void) {
    chroma_reset();
    chroma_enable(1);
    chroma_set_residual_mix(0.0f);   /* feed_raw ignores this; explicit anyway */
}

static const char *PC[12] = { "C","C#","D","D#","E","F","F#","G","G#","A","A#","B" };

static void chord_name(int idx, char *out, int cap) {
    if (idx < 0) { snprintf(out, cap, "N"); return; }
    snprintf(out, cap, "%s%s", PC[idx % 12], idx / 12 ? "m" : "");
}

/* ---------------------------------------------------------------- tests */

/* 1. Clean triads, every root, both qualities, three inversions, three
 *    registers. The floor test: this is the easiest input the detector will
 *    ever see. */
static void t_clean_triads(void) {
    int correct = 0, total = 0;
    char got[8], want[8];
    int worst_root = -1, worst_q = 0;

    for (int q = 0; q < 2; q++) {
        for (int root = 0; root < 12; root++) {
            for (int inv = 0; inv < 3; inv++) {
                for (int oct = 0; oct < 3; oct++) {
                    int n = SR * 2;
                    float *buf = calloc(n, sizeof(float));
                    add_triad(buf, n, root, q, inv, 48.0f + oct * 12.0f, 0.22f, 440.0f, 0, n);
                    reset();
                    run(buf, n);
                    free(buf);

                    int want_idx = q * 12 + root;
                    int got_idx = chroma_current_chord();
                    total++;
                    if (got_idx == want_idx) correct++;
                    else if (worst_root < 0) { worst_root = root; worst_q = q;
                        chord_name(got_idx, got, sizeof got); chord_name(want_idx, want, sizeof want); }
                }
            }
        }
    }
    float pct = 100.0f * correct / total;
    check("clean triads: >= 90% correct", pct >= 90.0f,
          "%d/%d (%.1f%%) — first miss: wanted %s, got %s", correct, total, pct, want, got);
    printf("       (clean-triad accuracy %.1f%%)\n", pct);
}

/* 2. Tuning. A large share of YouTube uploads are pitch-shifted, so a detector
 *    that assumes A=440 is transposed on a meaningful fraction of real songs. */
static void t_tuning(void) {
    const float rates[] = { 432.0f, 452.0f };
    for (int r = 0; r < 2; r++) {
        int correct = 0, total = 0;
        for (int root = 0; root < 12; root++) {
            for (int q = 0; q < 2; q++) {
                int n = SR * 5;                 /* long enough for the estimate to converge */
                float *buf = calloc(n, sizeof(float));
                add_triad(buf, n, root, q, 0, 48.0f, 0.22f, rates[r], 0, n);
                reset();
                run(buf, n);
                free(buf);
                total++;
                if (chroma_current_chord() == q * 12 + root) correct++;
            }
        }
        float pct = 100.0f * correct / total;
        char label[80];
        snprintf(label, sizeof label, "A=%.0f Hz: >= 75%% correct", rates[r]);
        check(label, pct >= 75.0f, "%d/%d (%.1f%%) — tuning estimate is not compensating",
              correct, total, pct);
    }

    /* And the estimate itself points the right way. */
    int n = SR * 6;
    float *buf = calloc(n, sizeof(float));
    add_triad(buf, n, 0, 0, 0, 48.0f, 0.22f, 432.0f, 0, n);
    reset();
    run(buf, n);
    free(buf);
    /* 432 Hz is ~32 cents flat of 440. */
    float est = chroma_get_tuning();
    check("tuning estimate detects a flat reference", est < -0.1f && est > -0.55f,
          "estimated %+.3f semitones, expected about -0.32", est);
}

/* 3. Noise. Must degrade, and must report N rather than inventing a chord. */
static void t_noise(void) {
    const float snr_db[] = { 0.0f, -6.0f, -12.0f };
    for (int s = 0; s < 3; s++) {
        int correct = 0, total = 0;
        for (int root = 0; root < 12; root++) {
            int n = SR * 3;
            float *buf = calloc(n, sizeof(float));
            add_triad(buf, n, root, 0, 0, 48.0f, 0.22f, 440.0f, 0, n);
            float amp = 0.22f * powf(10.0f, -snr_db[s] / 20.0f) * 0.35f;
            for (int i = 0; i < n; i++) buf[i] += frand() * amp;
            reset();
            run(buf, n);
            free(buf);
            total++;
            if (chroma_current_chord() == root) correct++;
        }
        char label[80];
        snprintf(label, sizeof label, "%.0f dB SNR: degrades gracefully", snr_db[s]);
        /* Only a floor — the point is that it does not collapse, not that it
         * hits a particular number under noise this heavy. */
        check(label, correct >= (s == 0 ? 8 : s == 1 ? 5 : 2),
              "%d/%d correct", correct, total);
    }

    /* Pure noise must produce nothing. A detector that always answers is worse
     * than useless: the user cannot tell a guess from a reading. */
    int n = SR * 3;
    float *buf = calloc(n, sizeof(float));
    for (int i = 0; i < n; i++) buf[i] = frand() * 0.05f;
    reset();
    run(buf, n);
    int events = 0;
    while (chroma_pop_event()) events++;
    free(buf);
    check("pure noise emits no chord events", events == 0, "%d events emitted", events);

    /* Silence likewise. */
    buf = calloc(n, sizeof(float));
    reset();
    run(buf, n);
    events = 0;
    while (chroma_pop_event()) events++;
    free(buf);
    check("silence emits no chord events", events == 0, "%d events emitted", events);
}

/* 4. Percussion. The transient freeze in the isolation stage exists so drum
 *    hits do not open the mask; here the concern is that they do not drag a
 *    chord boundary onto the backbeat. */
static void t_percussion(void) {
    int correct = 0, total = 0;
    for (int root = 0; root < 12; root++) {
        int n = SR * 3;
        float *buf = calloc(n, sizeof(float));
        add_triad(buf, n, root, 0, 0, 48.0f, 0.22f, 440.0f, 0, n);
        /* Kick and snare at 2 Hz. */
        for (int beat = 0; beat * SR / 2 < n; beat++) {
            int at = beat * SR / 2;
            for (int i = 0; i < 2000 && at + i < n; i++) {
                float env = expf(-i / 400.0f);
                float kick = sinf(2.0f * (float)M_PI * 55.0f * i / SR) * env * 0.5f;
                float snare = (beat % 2) ? frand() * env * 0.25f : 0.0f;
                buf[at + i] += kick + snare;
            }
        }
        reset();
        run(buf, n);
        free(buf);
        total++;
        if (chroma_current_chord() == root) correct++;
    }
    check("drums present: >= 75% correct", 100.0f * correct / total >= 75.0f,
          "%d/%d correct", correct, total);
}

/* 5. Segmentation and event timing. Validates the backdating: the decoder emits
 *    CH_HOLD frames late by construction, so an event whose TIMESTAMP is late
 *    means the backdating is broken, not that the decoder is slow. */
static void t_segmentation(void) {
    /* I - V - vi - IV in C, 2 s per chord, 2 bars. */
    const int roots[4] = { 0, 7, 9, 5 };
    const int quals[4] = { 0, 0, 1, 0 };
    const int per = SR * 2;
    const int reps = 2;
    int n = per * 4 * reps;
    float *buf = calloc(n, sizeof(float));
    for (int rep = 0; rep < reps; rep++) {
        for (int i = 0; i < 4; i++) {
            add_triad(buf, n, roots[i], quals[i], 0, 48.0f, 0.22f, 440.0f,
                      (rep * 4 + i) * per, per);
        }
    }
    reset();
    run(buf, n);
    free(buf);

    float times[32]; int idx[32]; int count = 0;
    while (chroma_pop_event() && count < 32) {
        float *e = chroma_get_event_ptr();
        if (e[1] < 0) { continue; }             /* ignore N segments */
        times[count] = e[0];
        idx[count] = (int)e[2] * 12 + (int)e[1];
        count++;
    }

    check("I-V-vi-IV emits one event per chord", count >= 7 && count <= 9,
          "%d events for 8 chords", count);

    int labels_ok = 0, timing_ok = 0;
    for (int i = 0; i < count && i < 8; i++) {
        if (idx[i] == quals[i % 4] * 12 + roots[i % 4]) labels_ok++;
        float want = (float)(i * 2);
        if (fabsf(times[i] - want) < 0.35f) timing_ok++;
    }
    check("segment labels are correct", labels_ok >= (count < 8 ? count : 8) - 1,
          "%d/%d labels correct", labels_ok, count < 8 ? count : 8);
    check("backdated event times land within 350 ms of the change",
          timing_ok >= (count < 8 ? count : 8) - 1,
          "%d/%d within tolerance (first at %.2fs, want 0.00s)",
          timing_ok, count < 8 ? count : 8, count ? times[0] : -1.0f);
}

/* 6. THE experiment. Analysing the residual instead of the mix is the reason
 *    chroma.c reaches into the isolation stage at all; if it does not help,
 *    that coupling should go. A loud vibrato melody on non-chord tones is
 *    exactly what a lead vocal does to a chromagram. */
static void t_residual_beats_mix(void) {
    const int roots[4] = { 0, 7, 9, 5 };
    const int quals[4] = { 0, 0, 1, 0 };
    const int per = SR * 2;
    int n = per * 4;

    float *harmony = calloc(n, sizeof(float));
    for (int i = 0; i < 4; i++)
        add_triad(harmony, n, roots[i], quals[i], 0, 48.0f, 0.20f, 440.0f, i * per, per);

    /* A melody that wanders onto the 2nd, 6th and 7th — non-chord tones — with
     * vibrato, at +6 dB over the harmony. */
    float *melody = calloc(n, sizeof(float));
    const float mel[8] = { 62, 64, 66, 67, 69, 71, 62, 65 };
    for (int s = 0; s < 8; s++) {
        int start = s * (n / 8);
        int len = n / 8;
        float f0 = midi_hz(mel[s], 440.0f);
        for (int i = 0; i < len; i++) {
            float vib = 1.0f + 0.03f * sinf(2.0f * (float)M_PI * 5.5f * i / SR);
            float env = (i < 480) ? i / 480.0f : ((i > len - 960) ? (float)(len - i) / 960.0f : 1.0f);
            if (env < 0) env = 0;
            melody[start + i] += 0.44f * env * sinf(2.0f * (float)M_PI * f0 * vib * i / SR);
        }
    }

    float *mix = calloc(n, sizeof(float));
    for (int i = 0; i < n; i++) mix[i] = harmony[i] + melody[i];

    /* "Residual" here is the ideal case the runtime approximates: the melody
     * removed. What is being tested is whether removing it helps at all. */
    int mix_correct = 0, res_correct = 0;
    for (int i = 0; i < 4; i++) {
        int want = quals[i] * 12 + roots[i];

        reset();
        run(mix + i * per, per);
        if (chroma_current_chord() == want) mix_correct++;

        reset();
        run(harmony + i * per, per);
        if (chroma_current_chord() == want) res_correct++;
    }

    free(harmony); free(melody); free(mix);

    check("residual beats mix on vocal-contaminated harmony",
          res_correct >= mix_correct,
          "mix %d/4 vs residual %d/4 — if the mix wins, the residual coupling "
          "in chroma_feed() is not earning its complexity", mix_correct, res_correct);
    printf("       (mix %d/4, residual %d/4)\n", mix_correct, res_correct);
}

/* 7. Rings and lifecycle. */
static void t_rings(void) {
    int n = SR * 2;
    float *buf = calloc(n, sizeof(float));
    add_triad(buf, n, 0, 0, 0, 48.0f, 0.22f, 440.0f, 0, n);

    reset();
    run(buf, n);
    int frames = 0;
    while (chroma_pop_frame()) frames++;
    check("frames are produced at ~23 fps", frames > 20 && frames <= 96,
          "%d frames drained for 2s of audio (ring caps at 96)", frames);
    check("draining twice yields nothing the second time", chroma_pop_frame() == 0, "");

    /* Disabled means genuinely no work, so an ad or a paused tab cannot write
     * garbage into a chart. */
    chroma_reset();
    chroma_enable(0);
    int before = chroma_frame_count();
    for (int off = 0; off + BLOCK <= n; off += BLOCK) chroma_feed(BLOCK);
    check("disabled: feed() does nothing", chroma_frame_count() == before,
          "frame count moved from %d to %d", before, chroma_frame_count());

    chroma_enable(1);
    reset();
    run(buf, n);
    check("reset clears the frame count", (chroma_reset(), chroma_frame_count()) == 0, "");
    free(buf);
}

int main(void) {
    chroma_init(SR);

    printf("\n\x1b[1mclean triads\x1b[0m\n");        t_clean_triads();
    printf("\n\x1b[1mtuning\x1b[0m\n");              t_tuning();
    printf("\n\x1b[1mnoise\x1b[0m\n");               t_noise();
    printf("\n\x1b[1mpercussion\x1b[0m\n");          t_percussion();
    printf("\n\x1b[1msegmentation\x1b[0m\n");        t_segmentation();
    printf("\n\x1b[1mresidual vs mix\x1b[0m\n");     t_residual_beats_mix();
    printf("\n\x1b[1mrings\x1b[0m\n");               t_rings();

    chroma_cleanup();

    printf("\n");
    if (failures) { printf("\x1b[31m%d/%d assertions failed\x1b[0m\n", failures, checks); return 1; }
    printf("\x1b[32m%d/%d assertions passed\x1b[0m\n", checks, checks);
    return 0;
}
