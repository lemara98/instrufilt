/*
 * Chroma extraction and causal chord recognition.
 *
 * Pipeline, per 2048-sample hop:
 *
 *   residual -> 8192-pt FFT -> sqrt-compressed magnitudes
 *            -> tuning estimate (circular mean of semitone deviation)
 *            -> 12-bin chroma + separate 12-bin BASS chroma
 *            -> template match over 24 triads + N
 *            -> hysteresis with backdated event times
 *
 * Two choices here carry most of the accuracy, and both are cheap:
 *
 *   The BASS chroma is what separates C from Am and G from Em. Those share two
 *   of three tones, so plain chroma cannot tell them apart at all; the root in
 *   the bass can. It is the single highest-value addition beyond a plain
 *   chromagram.
 *
 *   The VOCABULARY stops at major and minor. Adding 7ths takes 25 classes to 60,
 *   distinguished by a single pitch class that sits well inside the noise floor
 *   at this feature quality. The result is not richer chords, it is a chart that
 *   alternates between C and Cmaj7 every bar — strictly worse than a stable,
 *   slightly under-specified one. 7ths belong later, as a decoration applied to
 *   an already-committed segment.
 */

#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "kiss_fft.h"
#include "kiss_fftr.h"
#include "isolate.h"
#include "chroma.h"

#define CH_FFT   8192
#define CH_HOP   2048
#define CH_BINS  (CH_FFT / 2 + 1)

/* Analysis range. Below A1 there is nothing but rumble; above C#7 nothing but
 * cymbal wash and harmonics too high to identify a root from. */
#define F_LO 55.0f
#define F_HI 2200.0f

/* Bass window, MIDI 28 (E1) to 52 (E3) — where a bass guitar and a left hand
 * actually live. */
#define BASS_LO_MIDI 28.0f
#define BASS_HI_MIDI 52.0f

/* A challenger must beat the incumbent for this many consecutive frames before
 * an event fires. 8 frames is ~340 ms at 23.4 fps — long enough to reject a
 * passing tone, short enough not to miss a fast change. */
#define CH_HOLD 8

#define FRAME_RING 96
#define EVENT_RING 32

#define CH_SILENCE 1e-4f

/* Minimum template fit before a frame names a chord at all. An L2-normalised
 * flat chroma — white noise, or a dense inharmonic wash — scores exactly 0.5
 * against every triad, so the gate has to sit above that. */
#define CH_MIN_FIT 0.58f

/* Minimum MEAN confidence across the hold window before an event is emitted.
 *
 * The hold alone is not enough to reject noise. Chroma is EMA-smoothed with a
 * ~150 ms constant, so consecutive frames are correlated and a random argmax
 * can repeat 8 times by chance. Confidence is margin-based, so on noise — where
 * every candidate scores alike — it stays near zero however long the run. */
#define CH_MIN_EVENT_CONF 0.25f

/* ------------------------------------------------------------------ state */

static float sr_hz = 48000.0f;
static int   enabled = 0;
static float residual_mix = 0.8f;

static kiss_fftr_cfg ch_cfg = NULL;

static float ch_buf[CH_FFT];      /* rolling analysis window                */
static int   ch_fill = 0;         /* samples accumulated since the last hop */
static long  ch_total = 0;        /* samples consumed since reset           */
static int   ch_frames = 0;

static float ch_win[CH_FFT];
static float ch_time[CH_FFT];
static kiss_fft_cpx ch_spec[CH_BINS];
static float mag[CH_BINS];

/* Precomputed per bin — log2f and expf run once at init, never per frame. */
static float bin_midi[CH_BINS];
static float bin_w[CH_BINS];      /* octave salience; 0 = outside the range */
static unsigned char bin_bass[CH_BINS];

static float chroma[12], bass_ch[12], chroma_sm[12];

/* Tuning: leaky circular mean of each bin's fractional-semitone deviation. */
static float tune_re = 0.0f, tune_im = 0.0f, tuning = 0.0f;

static int   cur_chord = CHORD_NONE;
static float cur_conf = 0.0f;
static int   pending = -2;
static int   hold = 0;
static float conf_acc = 0.0f;
static float frame_energy = 0.0f;

static float frame_ring[FRAME_RING][CHROMA_FRAME_FLOATS];
static int   frame_head = 0, frame_tail = 0;
static float frame_out[CHROMA_FRAME_FLOATS];

static float event_ring[EVENT_RING][CHROMA_EVENT_FLOATS];
static int   event_head = 0, event_tail = 0;
static float event_out[CHROMA_EVENT_FLOATS];

/* ---------------------------------------------------------------- helpers */

static void build_tables(void) {
    for (int i = 0; i < CH_FFT; i++) {
        ch_win[i] = 0.5f * (1.0f - cosf(2.0f * 3.14159265358979f * i / CH_FFT));
    }

    const float bin_hz = sr_hz / (float)CH_FFT;
    for (int k = 0; k < CH_BINS; k++) {
        float f = k * bin_hz;
        bin_w[k] = 0.0f;
        bin_bass[k] = 0;
        bin_midi[k] = 0.0f;
        if (f < F_LO || f > F_HI) continue;

        bin_midi[k] = 69.0f + 12.0f * log2f(f / 440.0f);

        /* Octave salience: a Gaussian centred on C4 (MIDI 60), sigma 15
         * semitones. Keeps the chroma dominated by the register chords are
         * actually voiced in, so sub rumble and cymbal wash cannot steer it. */
        float d = (bin_midi[k] - 60.0f) / 15.0f;
        bin_w[k] = expf(-0.5f * d * d);
        bin_bass[k] = (bin_midi[k] >= BASS_LO_MIDI && bin_midi[k] <= BASS_HI_MIDI);
    }
}

static void l2_normalize(float *v, int n) {
    float s = 0.0f;
    for (int i = 0; i < n; i++) s += v[i] * v[i];
    if (s <= 1e-12f) return;
    float inv = 1.0f / sqrtf(s);
    for (int i = 0; i < n; i++) v[i] *= inv;
}

static void tuning_update(void) {
    for (int k = 0; k < CH_BINS; k++) {
        if (bin_w[k] <= 0.0f || mag[k] <= 0.0f) continue;
        float frac = bin_midi[k] - floorf(bin_midi[k] + 0.5f);   /* -0.5..0.5 */
        float th = 6.28318531f * frac;
        tune_re += mag[k] * cosf(th);
        tune_im += mag[k] * sinf(th);
    }
    /* Leak, so the estimate tracks a change of source rather than averaging
     * the whole session. tau ~ 8.5 s at 23.4 fps. */
    tune_re *= 0.995f;
    tune_im *= 0.995f;
    if (tune_re * tune_re + tune_im * tune_im > 1e-6f) {
        tuning = atan2f(tune_im, tune_re) / 6.28318531f;
    }
}

/* Major and minor triads as pitch-class sets, rooted at 0. */
static const float TPL_MAJ[12] = { 1,0,0,0,1,0,0,1,0,0,0,0 };   /* 0 4 7 */
static const float TPL_MIN[12] = { 1,0,0,1,0,0,0,1,0,0,0,0 };   /* 0 3 7 */

/* Returns q*12+r, or CHORD_NONE. Writes 0..1 confidence.
 *
 * Ranking and the N gate use DIFFERENT quantities, on purpose. Ranking uses
 * template fit plus bass evidence, because the bass is what tells C from Am.
 * The gate uses template fit ALONE, because the question it answers is "does
 * this spectrum look like a triad at all", and bass evidence cannot help with
 * that — it only shifts every candidate up together.
 *
 * Conflating them let white noise through: an L2-normalised flat chroma scores
 * exactly 0.5 against any triad, under the 0.55 gate, but the bass bonus lifted
 * it to ~0.58 and the detector confidently named a chord in static. */
static int match_chord(float *out_conf) {
    float best = -1e9f, second = -1e9f, best_fit = 0.0f;
    int best_idx = CHORD_NONE;

    for (int q = 0; q < 2; q++) {
        const float *tpl = q ? TPL_MIN : TPL_MAJ;
        const int third = q ? 3 : 4;
        for (int r = 0; r < 12; r++) {
            float dot = 0.0f;
            for (int i = 0; i < 12; i++) dot += chroma_sm[(r + i) % 12] * tpl[i];
            dot *= 0.5773503f;                            /* 1/sqrt(3) */

            /* Root in the bass is strong evidence; another chord tone in the
             * bass is weak evidence (an inversion). Weighted low on purpose so
             * a walking bass line cannot override a clear triad above it. */
            float bb = 0.22f * bass_ch[r]
                     + 0.08f * (bass_ch[(r + third) % 12] + bass_ch[(r + 7) % 12]);

            float s = dot + bb;
            if (s > best) { second = best; best = s; best_idx = q * 12 + r; best_fit = dot; }
            else if (s > second) { second = s; }
        }
    }

    float margin = best - second;
    *out_conf = margin / (margin + 0.06f);

    if (frame_energy < CH_SILENCE || best_fit < CH_MIN_FIT) {
        *out_conf = 0.0f;
        return CHORD_NONE;
    }
    return best_idx;
}

/* Window-centre time on the ISOLATION INPUT timeline, in seconds.
 *
 * Two offsets, both folded in here so no caller has to remember them:
 *   - CH_FFT/2, because a frame describes the CENTRE of its window, not its end
 *   - the isolation group delay, because chroma reads the delay-matched dry
 *     buffer, which lags the input by exactly that much
 *
 * Getting this wrong shifts every chord in the chart by a fixed amount, which
 * looks like a detector that is merely "a bit late" rather than a bug. */
static double frame_time_for(long total_samples) {
    double s = (double)total_samples - (double)CH_FFT * 0.5 - (double)ISO_LATENCY_SAMPLES;
    return s / (double)sr_hz;
}

static void push_frame(void) {
    float *row = frame_ring[frame_head];
    row[0] = (float)frame_time_for(ch_total);
    row[1] = tuning;
    for (int i = 0; i < 12; i++) row[2 + i] = chroma_sm[i];
    for (int i = 0; i < 12; i++) row[14 + i] = bass_ch[i];
    row[26] = frame_energy;
    row[27] = iso_frame_flux;

    frame_head = (frame_head + 1) % FRAME_RING;
    /* Drop the OLDEST on overflow. A stalled drain means the panel closed or
     * the page froze; the newest frames are the ones still worth having. */
    if (frame_head == frame_tail) frame_tail = (frame_tail + 1) % FRAME_RING;
}

static void push_event(int chord, double t, float conf) {
    float *row = event_ring[event_head];
    row[0] = (float)t;
    row[1] = chord == CHORD_NONE ? -1.0f : (float)(chord % 12);
    row[2] = chord == CHORD_NONE ? -1.0f : (float)(chord / 12);
    row[3] = conf;
    row[4] = -1.0f;
    row[5] = 0.0f;

    event_head = (event_head + 1) % EVENT_RING;
    if (event_head == event_tail) event_tail = (event_tail + 1) % EVENT_RING;
}

static void process_frame(void) {
    for (int i = 0; i < CH_FFT; i++) ch_time[i] = ch_buf[i] * ch_win[i];
    kiss_fftr(ch_cfg, ch_time, ch_spec);

    double energy = 0.0;
    for (int k = 0; k < CH_BINS; k++) {
        float m = sqrtf(ch_spec[k].r * ch_spec[k].r + ch_spec[k].i * ch_spec[k].i);
        energy += (double)m * m;
        /* sqrt compression: without it one loud partial owns the whole chroma
         * vector and the triad underneath it disappears. */
        mag[k] = sqrtf(m);
    }
    frame_energy = (float)(energy / (double)CH_BINS);

    tuning_update();
    /* Before ~3 s the circular mean has not converged; a half-converged tuning
     * is worse than none, because it smears energy across two pitch classes. */
    float tune = (ch_frames > 70) ? tuning : 0.0f;

    for (int p = 0; p < 12; p++) { chroma[p] = 0.0f; bass_ch[p] = 0.0f; }

    for (int k = 0; k < CH_BINS; k++) {
        if (bin_w[k] <= 0.0f) continue;
        float midi = bin_midi[k] - tune;
        float nearest = floorf(midi + 0.5f);
        float dev = midi - nearest;                       /* -0.5..0.5 */
        /* Raised cosine: full weight at the semitone centre, zero at the
         * boundary. Halves the inter-semitone smear for one cosf. */
        float w = 0.5f * (1.0f + cosf(6.28318531f * dev));
        int pc = ((int)nearest) % 12;
        if (pc < 0) pc += 12;

        float e = mag[k] * w;
        chroma[pc] += e * bin_w[k];
        if (bin_bass[k]) bass_ch[pc] += e;
    }

    l2_normalize(chroma, 12);
    l2_normalize(bass_ch, 12);

    /* tau ~150 ms: rides over a passing tone without blurring a real change. */
    for (int p = 0; p < 12; p++) chroma_sm[p] += 0.25f * (chroma[p] - chroma_sm[p]);

    ch_frames++;
    push_frame();

    /* --- causal decode --------------------------------------------------- */
    float conf = 0.0f;
    int cand = match_chord(&conf);

    if (cand == cur_chord) {
        pending = -2;
        hold = 0;
    } else if (cand == pending) {
        hold++;
        conf_acc += conf;
        if (hold >= CH_HOLD) {
            float mean_conf = conf_acc / (float)CH_HOLD;
            /* Held long enough, but only commit if the run was actually
             * confident. Otherwise treat it as unresolved: keep the incumbent
             * and let the next candidate try. */
            if (cand == CHORD_NONE || mean_conf >= CH_MIN_EVENT_CONF) {
                /* BACKDATE to when the challenger first appeared. The event is
                 * emitted CH_HOLD frames late by construction, but its
                 * timestamp is correct — so a chart built from this causal pass
                 * is accurately timed even though nothing looks ahead. */
                long back = ch_total - (long)CH_HOLD * CH_HOP;
                push_event(cand, frame_time_for(back), mean_conf);
                cur_chord = cand;
                cur_conf = mean_conf;
            }
            pending = -2;
            hold = 0;
            conf_acc = 0.0f;
        }
    } else {
        pending = cand;
        hold = 1;
        conf_acc = conf;
    }
}

/* --------------------------------------------------------------- exported */

void chroma_init(int sample_rate) {
    sr_hz = sample_rate > 0 ? (float)sample_rate : 48000.0f;
    if (ch_cfg) { free(ch_cfg); ch_cfg = NULL; }
    ch_cfg = kiss_fftr_alloc(CH_FFT, 0, NULL, NULL);
    build_tables();
    chroma_reset();
}

void chroma_cleanup(void) {
    if (ch_cfg) { free(ch_cfg); ch_cfg = NULL; }
}

void chroma_enable(int on) { enabled = on ? 1 : 0; }
int  chroma_is_enabled(void) { return enabled; }

void chroma_reset(void) {
    memset(ch_buf, 0, sizeof(ch_buf));
    memset(chroma, 0, sizeof(chroma));
    memset(bass_ch, 0, sizeof(bass_ch));
    memset(chroma_sm, 0, sizeof(chroma_sm));
    ch_fill = 0;
    ch_total = 0;
    ch_frames = 0;
    tune_re = tune_im = tuning = 0.0f;
    cur_chord = CHORD_NONE;
    cur_conf = 0.0f;
    pending = -2;
    hold = 0;
    conf_acc = 0.0f;
    frame_energy = 0.0f;
    frame_head = frame_tail = 0;
    event_head = event_tail = 0;
}

static void feed_samples(const float *l, const float *r, int n, const float *wl, const float *wr) {
    for (int i = 0; i < n; i++) {
        float mid = 0.5f * (l[i] + r[i]);
        if (wl) mid -= residual_mix * 0.5f * (wl[i] + wr[i]);

        /* Shift-by-one into a rolling window would be O(CH_FFT) per sample;
         * append and memmove once per hop instead. */
        ch_buf[CH_FFT - CH_HOP + ch_fill] = mid;
        ch_fill++;
        ch_total++;

        if (ch_fill >= CH_HOP) {
            /* Wait for a genuinely full window. Emitting from the first hop
             * would publish three frames whose window is three-quarters zeros —
             * meaningless chroma, and timestamps that fall BEFORE the audio
             * starts, because the window centre is still in the zero-padding.
             * The isolation STFT makes the same choice for the same reason. */
            if (ch_total >= CH_FFT) process_frame();
            memmove(ch_buf, ch_buf + CH_HOP, (CH_FFT - CH_HOP) * sizeof(float));
            ch_fill = 0;
        }
    }
}

void chroma_feed(int num_samples) {
    if (!enabled || !ch_cfg) return;
    feed_samples(isolate_get_dry_l(), isolate_get_dry_r(), num_samples,
                 isolate_get_wet_l(), isolate_get_wet_r());
}

void chroma_feed_raw(const float *l, const float *r, int n) {
    if (!ch_cfg) return;
    feed_samples(l, r, n, NULL, NULL);
}

int chroma_pop_frame(void) {
    if (frame_tail == frame_head) return 0;
    memcpy(frame_out, frame_ring[frame_tail], sizeof(frame_out));
    frame_tail = (frame_tail + 1) % FRAME_RING;
    return 1;
}
float *chroma_get_frame_ptr(void) { return frame_out; }

int chroma_pop_event(void) {
    if (event_tail == event_head) return 0;
    memcpy(event_out, event_ring[event_tail], sizeof(event_out));
    event_tail = (event_tail + 1) % EVENT_RING;
    return 1;
}
float *chroma_get_event_ptr(void) { return event_out; }

float chroma_get_tuning(void) { return tuning; }
int   chroma_frame_count(void) { return ch_frames; }

void  chroma_set_residual_mix(float mix) {
    if (mix < 0.0f) mix = 0.0f;
    if (mix > 1.0f) mix = 1.0f;
    residual_mix = mix;
}

int   chroma_current_chord(void) { return cur_chord; }
float chroma_current_confidence(void) { return cur_conf; }
