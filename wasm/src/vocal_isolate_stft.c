/*
 * STFT-based lead-vocal ISOLATION.
 *
 * The inverse of Karafilt's vocal_remove_stft.c, and deliberately not a
 * one-line inversion of it. Karafilt outputs `mix - vocal`, so the surviving
 * instrumental masks every artifact the mask produces. Here the mask IS the
 * output, which turns four latent issues in that file into audible failures:
 *
 *   1. OUT-OF-BAND BINS AND DC.  vocal_remove_stft.c:144 does
 *        `if (fw <= 0.0f) continue;`
 *      which leaves out-of-band bins untouched. That is correct for removal —
 *      it is precisely the bass/air protection. It is backwards here: out of
 *      band means kick, bass and cymbals, i.e. exactly the leak we exist to
 *      remove, and `continue` would pass them through at full level. We ZERO
 *      instead. Same for DC (skipped there at :141), which additionally clicks
 *      once the surrounding spectrum is gone.
 *
 *   2. NO TEMPORAL SMOOTHING.  The mask is recomputed per frame with no
 *      continuity. Under a surviving instrumental that flutter is inaudible;
 *      as the only signal it is the loudest thing in the output ("musical
 *      noise"). We smooth per bin with a fast attack and a slow release, and
 *      leave a spectral floor rather than hard-zeroing.
 *
 *   3. OLA GAIN.  Hann analysis x Hann synthesis at 4x overlap sums to exactly
 *      1.5, and vocal_remove_stft.c:201 applies only 1/FFT_SIZE — so its output
 *      runs +3.5 dB hot. (Its own test asserts the bug.) We derive the window
 *      -square sum at init, so reconstruction is unity and stays unity if the
 *      window or overlap ever changes.
 *
 *   4. CENTRED DRUMS AND BASS.  `centerness` cannot tell a voice from a centred
 *      kick. The cheap discriminator is simultaneity: a drum hit lights up many
 *      bins at once, a sung note does not. We do NOT duck the output on hits —
 *      that would tremolo the vocal at the backbeat. We freeze the mask's
 *      ATTACK, so bins already open (a sustaining vocal) stay open while bins
 *      that want to newly open (the hit) cannot.
 *
 *   5. PANNING IS NOT IDENTITY.  Traps 1-4 all presuppose that `centerness` can
 *      find the vocal at all. Structurally it cannot: a centred kick, a centred
 *      bass and a centred rhythm guitar score exactly what the singer scores,
 *      and no value of cexp separates them — it is a pan estimator, and they
 *      are panned identically. That is the ceiling of every pan-based method,
 *      and it is why the mask carries a second, independent term. See the REPET
 *      section below.
 *
 * Signal flow:
 *
 *     out = (1 - amount) * dry[n - FFT_SIZE]  +  amount * limit(makeup * wet[n])
 *
 * and the per-bin mask driving `wet` is a product of independent estimators:
 *
 *     target = band_weight * centerness * transient_penalty * repet_gain
 *
 * centerness asks WHERE this energy is panned; repet_gain asks WHETHER it was
 * also here a bar ago. They fail on different material, which is the point of
 * multiplying them rather than picking one.
 *
 * The real dry delay line costs 16 KB and buys three things: `amount == 0` is
 * bit-exact passthrough (a hard assertion, and an honest A/B for the user);
 * "vocal plus a bit of the band" is far more practisable than a naked vocal;
 * and because analysis/synthesis is now perfect-reconstruction, the exact
 * instrumental residual `dry_delayed - wet` falls out for free. chroma.c reads
 * that residual for chord detection without a second FFT.
 */

#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "kiss_fft.h"
#include "kiss_fftr.h"
#include "isolate.h"

#define FFT_SIZE     2048
#define HOP_SIZE     512
#define OVERLAP      (FFT_SIZE / HOP_SIZE)  /* 4 */
#define NUM_BINS     (FFT_SIZE / 2 + 1)
#define OLA_SIZE     16384                  /* power of 2 */
#define OLA_MASK     (OLA_SIZE - 1)
#define DLY_SIZE     4096                   /* > FFT_SIZE, power of 2 */
#define DLY_MASK     (DLY_SIZE - 1)
#define MAX_BLOCK    512

/* ---------------------------------------------------------------- state */

static float in_buf_l[FFT_SIZE];
static float in_buf_r[FFT_SIZE];
static int   in_count = 0;
static int   hop_count = 0;

static float ola_l[OLA_SIZE];
static float ola_r[OLA_SIZE];
static int   ola_write = 0;
static int   ola_read = 0;

/* Dry delay line, matched to the STFT's FFT_SIZE group delay. */
static float dly_l[DLY_SIZE];
static float dly_r[DLY_SIZE];
static int   dly_write = 0;

static kiss_fftr_cfg fft_fwd = NULL;
static kiss_fftr_cfg fft_inv = NULL;

static float window[FFT_SIZE];
static float frame_l[FFT_SIZE];
static float frame_r[FFT_SIZE];
static float ifft_l[FFT_SIZE];
static float ifft_r[FFT_SIZE];
static kiss_fft_cpx spec_l[NUM_BINS];
static kiss_fft_cpx spec_r[NUM_BINS];

/* Per-bin smoothing state (trap 2) and transient tracking (trap 4). */
static float mask_state[NUM_BINS];
static float mag_prev[NUM_BINS];
static float mag_cur[NUM_BINS];

static float ola_norm = 0.0f;   /* derived at init — trap 3 */
static float sample_rate_hz = 48000.0f;
static int   latency_remaining = 0;

/* -------------------------------------------------------------- params */

/* "Vocal + rhythm" is the SAME code path with wider band edges. Extending down
 * to 45 Hz does not readmit "instruments" — it readmits centred kick, bass and
 * snare, which in virtually every mix IS the rhythm section. That is why the
 * mode is nearly free, and why it is the default: a musician practising to a
 * naked vocal has no time reference to lock to. */
typedef struct {
    float ramp_lo, full_lo, full_hi, ramp_hi;  /* band_weight edges (Hz) */
    float cexp;         /* centerness exponent — higher = stricter centre */
    float side_bleed;   /* fraction of the side channel readmitted */
    float floor;        /* spectral floor, linear */
    float att_tau;      /* mask attack time constant, seconds */
    float rel_tau;      /* mask release time constant, seconds */
    float makeup_db;
    float repet;        /* online REPET strength, 0 = stage off entirely */
} iso_mode_t;

/* VOCAL_RHYTHM's low edge sits at 20/40 Hz, not 45/70. The point of the mode is
 * to KEEP the rhythm section, and 60 Hz is a completely ordinary kick and bass
 * fundamental — a band edge ramping through it attenuates the groove by a third
 * and gets worse as the sample rate rises and bins get wider. Below 20 Hz there
 * is nothing worth keeping, so the ramp costs nothing where it sits now. */
/* REPET is OFF in VOCAL_RHYTHM, and that is not an oversight to be tuned away
 * later. The mode exists to keep the centred rhythm section; the rhythm section
 * is the most repetitive thing in the mix and therefore the first thing REPET
 * destroys. Enabling it there would not produce a better "vocal + rhythm", it
 * would produce VOCAL_ONLY with worse band edges. */
static const iso_mode_t MODES[ISO_MODE_COUNT] = {
    /* VOCAL_ONLY   */ { 120.f, 190.f, 8000.f, 11000.f, 1.6f, 0.15f, 0.020f, .015f, .120f,  9.0f, 0.85f },
    /* VOCAL_RHYTHM */ {  20.f,  40.f, 9000.f, 13000.f, 1.0f, 0.35f, 0.060f, .012f, .090f,  4.0f, 0.00f },
    /* LEAD_LINE    */ { 180.f, 260.f, 5000.f,  7000.f, 2.2f, 0.05f, 0.015f, .010f, .150f, 11.0f, 0.95f },
};

static int   iso_mode = ISO_MODE_VOCAL_RHYTHM;
static float iso_amount = 1.0f;       /* 0 = dry passthrough, 1 = fully wet */
static int   iso_mono = 0;
static float makeup_lin = 1.0f;
static int   auto_gain_on = 0;

/* Smoothing coefficients are DERIVED from the sample rate, never baked.
 * AudioContext runs at 44100 / 48000 / 96000 depending on the machine, and a
 * hard-coded coefficient would make the smoothing 2x too fast at 96k — quietly
 * disabling musical-noise suppression on exactly the setups least likely to
 * report it. iso_test.c re-runs the smoothing assertion at all three rates. */
static float mask_att = 0.5f;
static float mask_rel = 0.085f;
static float att_tau_override = -1.0f;  /* test hook; <0 = use the mode's value */
static float rel_tau_override = -1.0f;
static int   mask_bypass = 0;           /* test hook; pure analysis/synthesis */

static void update_mask_coeffs(void) {
    const iso_mode_t *M = &MODES[iso_mode];
    float at = (att_tau_override >= 0.0f) ? att_tau_override : M->att_tau;
    float rt = (rel_tau_override >= 0.0f) ? rel_tau_override : M->rel_tau;
    const float T = (float)HOP_SIZE / sample_rate_hz;   /* 10.667 ms @48k */
    mask_att = (at <= 0.0f) ? 1.0f : 1.0f - expf(-T / at);
    mask_rel = (rt <= 0.0f) ? 1.0f : 1.0f - expf(-T / rt);
}

/* Slow AGC: 2 s attack / 4 s release toward -18 dBFS RMS, ceiling +18 dB.
 * Slow enough not to pump on a chorus, fast enough to level a quiet verse. */
static float agc_rms = 0.0f;
static float agc_gain = 1.0f;

/* DC blocker, 5 Hz one-pole, on the STFT INPUT ONLY.
 *
 * Zeroing bin 0 is not sufficient: a DC offset leaks through the Hann main lobe
 * into bins 1-2 as well, and in VOCAL_RHYTHM those bins are deliberately inside
 * the pass band — more so at 96 kHz, where a bin is 47 Hz wide. Removing DC in
 * the time domain kills it at any sample rate, independent of bin layout.
 *
 * Deliberately NOT applied to the dry delay line: that would break the
 * bit-exact `amount == 0` passthrough, which is worth more than removing a DC
 * offset from a signal the user asked to hear unprocessed. */
static float dcb_x1_l = 0.0f, dcb_y1_l = 0.0f;
static float dcb_x1_r = 0.0f, dcb_y1_r = 0.0f;
static float dcb_r = 0.9993f;

static void update_dcb_coeff(void) {
    float r = 1.0f - (2.0f * 3.14159265358979f * 5.0f / sample_rate_hz);
    if (r < 0.9f) r = 0.9f;
    if (r > 0.99999f) r = 0.99999f;
    dcb_r = r;
}

/* ------------------------------------------------------------- helpers */

static void build_window(void) {
    for (int i = 0; i < FFT_SIZE; i++)
        window[i] = 0.5f * (1.0f - cosf(2.0f * 3.14159265358979f * i / FFT_SIZE));
}

static inline float taper_ramp(float x) {
    if (x <= 0.0f) return 0.0f;
    if (x >= 1.0f) return 1.0f;
    return 0.5f * (1.0f - cosf(3.14159265358979f * x));
}

/* Per-bin frequency weight. 0 outside the band -> the bin is ZEROED (trap 1),
 * which is the opposite of Karafilt, where 0 means "leave this bin alone". */
static float band_weight(float f, const iso_mode_t *M) {
    if (f <= M->ramp_lo || f >= M->ramp_hi) return 0.0f;
    if (f < M->full_lo)  return taper_ramp((f - M->ramp_lo) / (M->full_lo - M->ramp_lo));
    if (f > M->full_hi)  return taper_ramp((M->ramp_hi - f) / (M->ramp_hi - M->full_hi));
    return 1.0f;
}

/* Identity below -1 dBFS, so `amount == 0` stays bit-exact for any normal
 * input; soft knee above, so makeup gain compresses rather than clips. */
static inline float soft_limit(float x) {
    const float T = 0.891251f;   /* -1 dBFS */
    float a = fabsf(x);
    if (a <= T) return x;
    float over = (a - T) / (1.0f - T);
    return copysignf(T + (1.0f - T) * tanhf(over), x);
}

/* -------------------------------------------------------------- REPET
 *
 * Online REPET-SIM — the second half of the mask, and the half that addresses
 * what `centerness` structurally cannot (trap 5).
 *
 * Panning tells you where a source sits, not what it is. What separates the
 * band from the singer is not position but REPETITION: the band plays the same
 * bar again, the singer does not sing the same bar again.
 *
 * Per hop we hold a rolling ~11 s history of the mid magnitude spectrum,
 * reduced to RP_BANDS log-spaced bands. We slice that history into RP_K time
 * buckets, take the single most cosine-similar frame from each, use the per-band
 * MEDIAN across those matches as the background estimate, and keep whatever the
 * current frame has in excess of it. The result multiplies into `target`
 * alongside centerness, so it inherits the existing attack/release smoother for
 * free rather than needing a second smoother of its own.
 *
 * One match per bucket rather than the K globally best is the single most
 * important detail in here — see the note at the search loop. It is worth ~8 dB
 * on the vocal.
 *
 * Three properties are what make this affordable inside an AudioWorklet:
 *
 *   - It looks only BACKWARDS. Latency stays exactly FFT_SIZE; there is no
 *     lookahead introduced anywhere in the path, which is the whole reason to
 *     prefer it over the offline separators.
 *   - Band domain, not bin domain. 64 bands x 1024 frames is 262 KB and one
 *     similarity sweep is ~65k MACs, run every ~20 ms rather than every hop.
 *     Net cost on the whole DSP is +1% at 48 kHz and +18% at 96 kHz. A full-bin
 *     history would be 4.2 MB and would not fit the 8 MB heap beside chroma.
 *   - The history is stored on a sample-rate-derived STRIDE, so the window
 *     spans ~11 s of MUSIC at 44.1 / 48 / 96 kHz rather than 11.9 / 10.9 / 5.5.
 *     A REPET window that shrinks with the sample rate stops spanning a bar,
 *     and a background estimate over less than a bar is just a smoother.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not run in VOCAL_RHYTHM. See the note on MODES above.
 *   - It excludes the most recent ~1 s from the similarity search. The frames
 *     immediately behind the playhead are similar because the SAME NOTE is
 *     still sounding, not because anything repeated. Letting them into the
 *     median would put the vocal into its own background estimate, and the
 *     stage would quietly cancel the one thing it exists to keep.
 *
 * Known limit, stated rather than hidden: a singer who repeats a phrase
 * identically inside the ~11 s window is, to this stage, indistinguishable from
 * the band. The median over one-match-per-bucket softens it — the phrase has to
 * recur in more than half of the twelve buckets to survive into the background
 * estimate, which at 11 s means roughly every 0.9 s — but does not remove it.
 */

/* 64 bands over 60 Hz - 12 kHz is 1.4 semitones each. This resolution is not
 * cosmetic: the band grid sets the smallest melodic move the stage can see, and
 * at 48 bands over 40 Hz - 16 kHz (2.2 semitones) a singer moving by a whole
 * tone stays inside one band, looks stationary, and gets suppressed as
 * background. The extra 65 KB and 16k MACs per hop buy that back. */
#define RP_BANDS   64
#define RP_FRAMES  1024                  /* power of 2 */
#define RP_MASK    (RP_FRAMES - 1)
#define RP_K       12                    /* time buckets, one match taken from each */

static float rp_hist[RP_FRAMES][RP_BANDS];
static float rp_hnorm[RP_FRAMES];        /* L2 norm of each stored row */
static int   rp_write = 0;
static int   rp_count = 0;
static int   rp_stride = 1;
static int   rp_stride_ctr = 0;
static int   rp_excl = 94;               /* newest frames excluded from the search */
static int   rp_search_every = 2;        /* hops between similarity sweeps */
static int   rp_search_ctr = 0;

static int   rp_band_lo[RP_BANDS + 1];   /* band b spans bins [lo[b], lo[b+1]) */
static float rp_centre[RP_BANDS];        /* band centre, in bins */
static int   rp_bin_band[NUM_BINS];
static float rp_bin_frac[NUM_BINS];
static float rp_cur[RP_BANDS];
static float rp_gain[RP_BANDS];
static float rp_strength_override = -1.0f;   /* <0 = use the mode's value */

static void rp_build_bands(void) {
    const float bin_hz = sample_rate_hz / (float)FFT_SIZE;
    float lo = 60.0f;
    float hi = 12000.0f;
    if (hi > sample_rate_hz * 0.45f) hi = sample_rate_hz * 0.45f;
    if (hi < lo * 4.0f) hi = lo * 4.0f;

    /* Every band must own at least one bin: at 48 kHz a bin is 23.4 Hz wide, so
     * the log grid collapses onto single bins below ~280 Hz. An empty band would
     * carry zero energy and hand back a meaningless gain for the bins around it. */
    int prev = 1;
    for (int b = 0; b < RP_BANDS; b++) {
        float f = lo * powf(hi / lo, (float)b / (float)RP_BANDS);
        int bin = (int)(f / bin_hz + 0.5f);
        int cap = NUM_BINS - 1 - (RP_BANDS - b);
        if (bin < prev) bin = prev;
        if (bin > cap)  bin = cap;
        rp_band_lo[b] = bin;
        prev = bin + 1;
    }
    {
        int top = (int)(hi / bin_hz + 0.5f);
        if (top > NUM_BINS) top = NUM_BINS;
        if (top < rp_band_lo[RP_BANDS - 1] + 1) top = rp_band_lo[RP_BANDS - 1] + 1;
        rp_band_lo[RP_BANDS] = top;
    }

    for (int b = 0; b < RP_BANDS; b++)
        rp_centre[b] = 0.5f * (float)(rp_band_lo[b] + rp_band_lo[b + 1] - 1);

    /* Bin -> (band, fraction) against band CENTRES, so the gain is interpolated
     * rather than stepped. A hard-edged 48-band gain is audible as a comb; the
     * interpolation costs one multiply-add per bin. Bins below the first centre
     * or above the last clamp to the edge band. */
    for (int k = 0; k < NUM_BINS; k++) {
        int b = 0;
        while (b < RP_BANDS - 2 && (float)k >= rp_centre[b + 1]) b++;
        float span = rp_centre[b + 1] - rp_centre[b];
        float f = (span > 0.0f) ? (((float)k - rp_centre[b]) / span) : 0.0f;
        if (f < 0.0f) f = 0.0f;
        if (f > 1.0f) f = 1.0f;
        rp_bin_band[k] = b;
        rp_bin_frac[k] = f;
    }
}

static void rp_init(void) {
    /* Stride so the history spans a constant amount of MUSIC, not a constant
     * number of hops — same reasoning as update_mask_coeffs(). */
    rp_stride = (int)(sample_rate_hz / 48000.0f + 0.5f);
    if (rp_stride < 1) rp_stride = 1;

    /* ~1 s of STORED frames. Doubles as the warm-up unit: the stage needs
     * 2 * rp_excl frames before it engages and fades in over the next
     * rp_excl, so it is fully on about 3 s after a reset. */
    float stored_hz = sample_rate_hz / (float)(HOP_SIZE * rp_stride);
    rp_excl = (int)(stored_hz + 0.5f);
    if (rp_excl < 8) rp_excl = 8;
    if (rp_excl > RP_FRAMES / 4) rp_excl = RP_FRAMES / 4;

    rp_search_every = (int)(0.020f * sample_rate_hz / (float)HOP_SIZE + 0.5f);
    if (rp_search_every < 1) rp_search_every = 1;

    rp_build_bands();
    isolate_repet_reset();
}

/* Reads mag_cur[], which Pass A has already filled for the flux measure — the
 * band reduction is the only new spectral work in here. */
static void rp_analyse(void) {
    const float EPS = 1e-12f;

    float norm = 0.0f;
    for (int b = 0; b < RP_BANDS; b++) {
        float s = 0.0f;
        for (int k = rp_band_lo[b]; k < rp_band_lo[b + 1]; k++) s += mag_cur[k];
        rp_cur[b] = s;
        norm += s * s;
    }
    norm = sqrtf(norm);

    float strength = (rp_strength_override >= 0.0f)
                   ? rp_strength_override : MODES[iso_mode].repet;
    int usable = rp_count - rp_excl;

    /* The sweep is the expensive part of the module — measured at +75% on the
     * whole DSP at 48 kHz and +145% at 96 kHz when run every hop. Decimating it
     * to ~20 ms costs nothing real: its output is a `target` term feeding the
     * 15 ms / 120 ms mask smoother, so the mask cannot follow a faster gain
     * anyway, and the background it estimates moves on the timescale of a bar.
     * Derived from the sample rate rather than fixed, so the interval is 20 ms
     * of music at 44.1 / 48 / 96 kHz and the cost per second stays flat.
     *
     * The HISTORY is still pushed every hop, below. Decimating that instead
     * would thin the buckets and coarsen the background estimate itself. */
    if (strength <= 0.0f || norm < EPS || usable < rp_excl) {
        for (int b = 0; b < RP_BANDS; b++) rp_gain[b] = 1.0f;
        rp_search_ctr = 0;                    /* sweep on the first eligible hop */
    } else if (--rp_search_ctr <= 0) {
        rp_search_ctr = rp_search_every;
        float ramp = (float)(usable - rp_excl) / (float)rp_excl;
        if (ramp > 1.0f) ramp = 1.0f;

        /* One match per TIME BUCKET, not the K globally best.
         *
         * The global top-K is what REPET-SIM literally specifies and it does not
         * survive contact with a real hop rate. A sung note lasts ~0.3 s, which
         * is ~28 frames, so a single past moment at a nearby pitch supplies more
         * than K candidates and takes every slot — the lead then fills its own
         * background estimate and the stage cancels it. Measured: the lead alone,
         * with no background in the signal at all, came back at 0.40x.
         *
         * Slicing the searchable history into RP_K contiguous buckets and keeping
         * the best match in each forces the K matches to be K DISTINCT MOMENTS
         * spread across the whole window. A background repeating every bar has a
         * match in every bucket; a lead phrase that recurred once can occupy at
         * most one, where the quantile ignores it. This is the minimum-separation
         * constraint REPET-SIM describes, expressed so it costs O(1) per
         * candidate rather than a scan of the selected set. */
        float best_sim[RP_K];
        int   best_idx[RP_K];
        int   have[RP_K];
        for (int j = 0; j < RP_K; j++) { best_sim[j] = -2.0f; best_idx[j] = 0; have[j] = 0; }

        const float inv = 1.0f / norm;
        const int span = usable;                 /* == rp_count - rp_excl, >= 1 */
        for (int j = rp_excl; j < rp_count; j++) {
            int idx = (rp_write - 1 - j) & RP_MASK;
            float hn = rp_hnorm[idx];
            if (hn < EPS) continue;
            const float *h = rp_hist[idx];
            float dot = 0.0f;
            for (int b = 0; b < RP_BANDS; b++) dot += rp_cur[b] * h[b];
            float sim = dot * inv / hn;

            int slot = (int)(((long)(j - rp_excl) * RP_K) / span);
            if (slot >= RP_K) slot = RP_K - 1;
            if (!have[slot] || sim > best_sim[slot]) {
                best_sim[slot] = sim;
                best_idx[slot] = idx;
                have[slot] = 1;
            }
        }

        int nbest = 0;
        for (int s = 0; s < RP_K; s++)
            if (have[s]) best_idx[nbest++] = best_idx[s];

        if (nbest < 2) {
            for (int b = 0; b < RP_BANDS; b++) rp_gain[b] = 1.0f;
        } else {
            for (int b = 0; b < RP_BANDS; b++) {
                float tmp[RP_K];
                for (int j = 0; j < nbest; j++) tmp[j] = rp_hist[best_idx[j]][b];
                for (int a = 1; a < nbest; a++) {          /* nbest <= 12 */
                    float v = tmp[a];
                    int c = a - 1;
                    while (c >= 0 && tmp[c] > v) { tmp[c + 1] = tmp[c]; c--; }
                    tmp[c + 1] = v;
                }
                /* The plain median, which is only defensible because the matches
                 * are one-per-bucket. A lower quantile was tried first, to hedge
                 * against the lead leaking into its own estimate; with the global
                 * top-K it helped (0.40x -> 0.66x on the lead) but never enough,
                 * because the bias it was compensating for was in the SELECTION.
                 * Once that was fixed the hedge became pure cost: at the 30th
                 * percentile the background survives at 0.20x against 0.03x for
                 * the median, and the lead only moves 0.93x -> 0.98x. */
                float bg = (nbest & 1) ? tmp[nbest >> 1]
                                       : 0.5f * (tmp[(nbest >> 1) - 1] + tmp[nbest >> 1]);

                /* The background cannot be louder than the mix containing it. */
                float cur = rp_cur[b];
                if (bg > cur) bg = cur;
                float fg = cur - bg;

                /* The magnitude ratio fg/cur, not the power form fg^2/(fg^2+bg^2).
                 * Wiener is the right gain when `bg` is an unbiased estimate of
                 * the interference, and a median over matched frames is not one:
                 * frames are selected FOR resembling the current one, so any
                 * foreground that recurs at all leaks into its own background
                 * estimate and `bg` reads high. Squaring an already-inflated bg
                 * roughly doubles the suppression, and it lands on the vocal —
                 * measured at 0.21x on the lead against 0.30x on the background,
                 * i.e. the wrong way round entirely. */
                float g = fg / (cur + EPS);
                rp_gain[b] = 1.0f - strength * ramp * (1.0f - g);
            }
        }
    }

    if (++rp_stride_ctr >= rp_stride) {
        rp_stride_ctr = 0;
        float *dst = rp_hist[rp_write];
        for (int b = 0; b < RP_BANDS; b++) dst[b] = rp_cur[b];
        rp_hnorm[rp_write] = norm;
        rp_write = (rp_write + 1) & RP_MASK;
        if (rp_count < RP_FRAMES) rp_count++;
    }
}

static inline float rp_bin_gain(int k) {
    int b = rp_bin_band[k];              /* <= RP_BANDS - 2, so b+1 is in range */
    return rp_gain[b] + rp_bin_frac[k] * (rp_gain[b + 1] - rp_gain[b]);
}

/* ------------------------------------------------------------ the frame */

static void process_one_frame(void) {
    const iso_mode_t *M = &MODES[iso_mode];
    const float bin_hz = sample_rate_hz / (float)FFT_SIZE;
    const float EPS = 1e-9f;

    for (int i = 0; i < FFT_SIZE; i++) {
        frame_l[i] = in_buf_l[i] * window[i];
        frame_r[i] = in_buf_r[i] * window[i];
    }
    kiss_fftr(fft_fwd, frame_l, spec_l);
    kiss_fftr(fft_fwd, frame_r, spec_r);

    /* --- Pass A: mid magnitudes + broadband transient measure (trap 4) --- */
    float flux = 0.0f;
    int flux_n = 0;
    for (int k = 1; k < NUM_BINS; k++) {
        float mr = 0.5f * (spec_l[k].r + spec_r[k].r);
        float mi = 0.5f * (spec_l[k].i + spec_r[k].i);
        float m  = sqrtf(mr * mr + mi * mi);
        float d  = m - mag_prev[k];
        if (d > 0.0f) { flux += d / (mag_prev[k] + 1e-5f); flux_n++; }
        mag_cur[k] = m;
    }
    if (flux_n) flux /= (float)flux_n;
    float hit = flux / (flux + 0.9f);   /* 0 = steady, ->1 = broadband hit */
    iso_frame_flux = hit;

    /* --- Trap 1a: zero DC. Karafilt skips k=0 to PROTECT bass; here that
     * would be raw mix leaking into a "vocal only" output, and the per-frame
     * DC step clicks audibly once the surrounding spectrum is gone. --- */
    if (!mask_bypass) {
        spec_l[0].r = spec_l[0].i = 0.0f;
        spec_r[0].r = spec_r[0].i = 0.0f;
    }

    /* --- Pass A2: the repetition estimate (trap 5) ---
     * Skipped under mask_bypass so that mode stays a pure analysis/synthesis
     * round trip and the reconstruction assertion measures only the STFT. */
    if (!mask_bypass) rp_analyse();

    /* --- Pass B: the mask --- */
    for (int k = 1; !mask_bypass && k < NUM_BINS; k++) {
        float freq = (float)k * bin_hz;
        float fw = band_weight(freq, M);

        /* Trap 1b: ZERO out-of-band, don't `continue`. Still run the release
         * so band edges decay smoothly rather than stepping. */
        if (fw <= 0.0f) {
            mask_state[k] += mask_rel * (0.0f - mask_state[k]);
            spec_l[k].r = spec_l[k].i = 0.0f;
            spec_r[k].r = spec_r[k].i = 0.0f;
            mag_prev[k] = mag_cur[k];
            continue;
        }

        float lr = spec_l[k].r, li = spec_l[k].i;
        float rr = spec_r[k].r, ri = spec_r[k].i;
        float mag_l = sqrtf(lr * lr + li * li);
        float mag_r = sqrtf(rr * rr + ri * ri);

        /* Magnitude balance and phase coherence — unchanged from
         * vocal_remove_stft.c:153-159. Together they estimate how
         * centre-panned this bin is, which is our vocal probability. */
        float bal = (2.0f * mag_l * mag_r) / (mag_l * mag_l + mag_r * mag_r + EPS);
        float dot = lr * rr + li * ri;
        float coh = dot / (mag_l * mag_r + EPS);
        if (coh < 0.0f) coh = 0.0f;
        if (coh > 1.0f) coh = 1.0f;

        float centerness = powf(bal * coh, M->cexp);

        /* Per-bin transient penalty: a partial that jumped more than 4x in one
         * hop is percussive, not vocal. Complements the frame-level `hit`. */
        float rise = mag_cur[k] / (mag_prev[k] + 1e-6f);
        float tpen = (rise > 4.0f) ? (4.0f / rise) : 1.0f;

        /* The two estimators multiply: centerness says this bin is centred,
         * repet_gain says it was not also here a bar ago. A centred rhythm
         * guitar passes the first and fails the second, which is the whole
         * reason this term exists. */
        float target = fw * centerness * tpen * rp_bin_gain(k);
        if (target > 1.0f) target = 1.0f;

        /* Trap 2. Fast attack keeps syllable onsets crisp; slow release bridges
         * the magnitude dips inside a sustained note and across vibrato — that
         * dip-and-recover cycle is exactly what warbles. */
        float a = (target > mask_state[k]) ? mask_att : mask_rel;
        if (hit > 0.45f && target > mask_state[k]) a *= (1.0f - hit);   /* freeze */
        mask_state[k] += a * (target - mask_state[k]);

        /* Spectral floor. A hard zero is what makes residual musical noise
         * *bubble*; leaving a little of the original turns it into a soft bed
         * the ear reads as room tone. */
        float g = M->floor + (1.0f - M->floor) * mask_state[k];

        /* The inversion. Karafilt (:176,:184,:190-193) keeps the sides and
         * nulls the centre. We keep the centre weighted by the vocal mask and
         * only a trace of the sides — enough vocal reverb tail that the result
         * is not bone-dry, not enough to readmit hard-panned instruments.
         * Note the bleed is multiplied by g, so side energy comes back only in
         * bins where the mask says a vocal is present: that vocal's own tail. */
        float keep_mid  = g;
        float keep_side = iso_mono ? 0.0f : (M->side_bleed * g);

        float mid_r = (lr + rr) * 0.5f;
        float mid_i = (li + ri) * 0.5f;
        float side_lr = lr - mid_r, side_li = li - mid_i;
        float side_rr = rr - mid_r, side_ri = ri - mid_i;
        spec_l[k].r = mid_r * keep_mid + side_lr * keep_side;
        spec_l[k].i = mid_i * keep_mid + side_li * keep_side;
        spec_r[k].r = mid_r * keep_mid + side_rr * keep_side;
        spec_r[k].i = mid_i * keep_mid + side_ri * keep_side;

        mag_prev[k] = mag_cur[k];
    }

    kiss_fftri(fft_inv, spec_l, ifft_l);
    kiss_fftri(fft_inv, spec_r, ifft_r);

    /* Trap 3: ola_norm folds in both KissFFT's 1/N and the window-square sum,
     * so reconstruction is unity rather than Karafilt's 1.5. */
    for (int i = 0; i < FFT_SIZE; i++) {
        int idx = (ola_write + i) & OLA_MASK;
        ola_l[idx] += ifft_l[i] * ola_norm * window[i];
        ola_r[idx] += ifft_r[i] * ola_norm * window[i];
    }
    ola_write = (ola_write + HOP_SIZE) & OLA_MASK;
}

static void push_sample(float l, float r) {
    in_buf_l[FFT_SIZE - HOP_SIZE + in_count] = l;
    in_buf_r[FFT_SIZE - HOP_SIZE + in_count] = r;
    in_count++;

    if (in_count >= HOP_SIZE) {
        hop_count++;
        if (hop_count >= OVERLAP) process_one_frame();
        memmove(in_buf_l, in_buf_l + HOP_SIZE, (FFT_SIZE - HOP_SIZE) * sizeof(float));
        memmove(in_buf_r, in_buf_r + HOP_SIZE, (FFT_SIZE - HOP_SIZE) * sizeof(float));
        in_count = 0;
    }
}

/* ------------------------------------------------------------ exported */

float iso_frame_flux = 0.0f;

static float io_in_l[MAX_BLOCK];
static float io_in_r[MAX_BLOCK];
static float io_out_l[MAX_BLOCK];
static float io_out_r[MAX_BLOCK];
/* The wet path before the dry blend — chroma.c reads dry_delayed - wet. */
static float io_wet_l[MAX_BLOCK];
static float io_wet_r[MAX_BLOCK];
static float io_dry_l[MAX_BLOCK];
static float io_dry_r[MAX_BLOCK];

float *isolate_get_input_l(void)  { return io_in_l; }
float *isolate_get_input_r(void)  { return io_in_r; }
float *isolate_get_output_l(void) { return io_out_l; }
float *isolate_get_output_r(void) { return io_out_r; }
float *isolate_get_wet_l(void)    { return io_wet_l; }
float *isolate_get_wet_r(void)    { return io_wet_r; }
float *isolate_get_dry_l(void)    { return io_dry_l; }
float *isolate_get_dry_r(void)    { return io_dry_r; }

void isolate_init(int sr) {
    sample_rate_hz = (sr > 0) ? (float)sr : 48000.0f;

    memset(in_buf_l, 0, sizeof(in_buf_l));
    memset(in_buf_r, 0, sizeof(in_buf_r));
    memset(ola_l, 0, sizeof(ola_l));
    memset(ola_r, 0, sizeof(ola_r));
    memset(dly_l, 0, sizeof(dly_l));
    memset(dly_r, 0, sizeof(dly_r));
    memset(mask_state, 0, sizeof(mask_state));
    memset(mag_prev, 0, sizeof(mag_prev));
    memset(mag_cur, 0, sizeof(mag_cur));

    in_count = hop_count = 0;
    ola_write = ola_read = 0;
    dly_write = 0;
    agc_rms = 0.0f;
    agc_gain = 1.0f;
    iso_frame_flux = 0.0f;
    dcb_x1_l = dcb_y1_l = dcb_x1_r = dcb_y1_r = 0.0f;
    update_dcb_coeff();

    if (fft_fwd) { free(fft_fwd); fft_fwd = NULL; }
    if (fft_inv) { free(fft_inv); fft_inv = NULL; }
    fft_fwd = kiss_fftr_alloc(FFT_SIZE, 0, NULL, NULL);
    fft_inv = kiss_fftr_alloc(FFT_SIZE, 1, NULL, NULL);

    build_window();

    /* Trap 3, derived rather than hard-coded: sum of w^2 over the hop
     * positions is 1.5 for Hann at 4x overlap, and stays correct if the
     * window or OVERLAP is ever changed. */
    float wsum = 0.0f;
    for (int m = 0; m < OVERLAP; m++) {
        float w = window[m * HOP_SIZE];
        wsum += w * w;
    }
    ola_norm = 1.0f / ((float)FFT_SIZE * wsum);

    update_mask_coeffs();
    isolate_set_makeup_db(MODES[iso_mode].makeup_db);

    /* After build_window(): rp_build_bands() needs nothing from it, but keeping
     * every derived table together makes the sample-rate dependency obvious. */
    rp_init();

    latency_remaining = FFT_SIZE;
}

void isolate_process(int num_samples) {
    if (num_samples > MAX_BLOCK) num_samples = MAX_BLOCK;

    for (int i = 0; i < num_samples; i++) {
        float l = io_in_l[i], r = io_in_r[i];

        /* Dry delay, matched to the STFT group delay so the blend is
         * phase-aligned and amount==0 is a true (delayed) passthrough. */
        dly_l[dly_write] = l;
        dly_r[dly_write] = r;
        int rd = (dly_write - FFT_SIZE) & DLY_MASK;
        float dl = dly_l[rd], dr = dly_r[rd];
        dly_write = (dly_write + 1) & DLY_MASK;

        /* DC-block the analysis input (wet path only — see update_dcb_coeff).
         * Skipped under mask_bypass so that mode is a pure analysis/synthesis
         * round trip and the reconstruction assertion measures only the STFT. */
        float hl = l, hr = r;
        if (!mask_bypass) {
            hl = l - dcb_x1_l + dcb_r * dcb_y1_l;
            hr = r - dcb_x1_r + dcb_r * dcb_y1_r;
            dcb_x1_l = l; dcb_y1_l = hl;
            dcb_x1_r = r; dcb_y1_r = hr;
        }

        push_sample(hl, hr);

        float wl, wr;
        if (latency_remaining > 0) {
            wl = wr = 0.0f;
            latency_remaining--;
        } else {
            wl = ola_l[ola_read & OLA_MASK];
            wr = ola_r[ola_read & OLA_MASK];
            ola_l[ola_read & OLA_MASK] = 0.0f;
            ola_r[ola_read & OLA_MASK] = 0.0f;
            ola_read = (ola_read + 1) & OLA_MASK;
        }

        io_dry_l[i] = dl;  io_dry_r[i] = dr;
        io_wet_l[i] = wl;  io_wet_r[i] = wr;
    }

    /* Slow AGC over the block, on the wet path only. */
    float gain = makeup_lin;
    if (auto_gain_on) {
        float sum = 0.0f;
        for (int i = 0; i < num_samples; i++)
            sum += io_wet_l[i] * io_wet_l[i] + io_wet_r[i] * io_wet_r[i];
        float rms = sqrtf(sum / (float)(num_samples * 2) + 1e-12f);
        float blk = (float)num_samples / sample_rate_hz;
        float tau = (rms > agc_rms) ? 2.0f : 4.0f;
        agc_rms += (1.0f - expf(-blk / tau)) * (rms - agc_rms);
        if (agc_rms > 1e-5f) {
            float want = 0.1259f / agc_rms;              /* target -18 dBFS */
            if (want > 7.943f) want = 7.943f;            /* ceiling +18 dB  */
            if (want < 0.5f)   want = 0.5f;
            agc_gain += 0.2f * (want - agc_gain);
        }
        gain *= agc_gain;
    }

    /* Makeup applies to WET ONLY, so amount==0 stays bit-exact and the
     * isolation slider never changes the dry component's loudness. */
    for (int i = 0; i < num_samples; i++) {
        float ol = (1.0f - iso_amount) * io_dry_l[i] + iso_amount * (gain * io_wet_l[i]);
        float or_ = (1.0f - iso_amount) * io_dry_r[i] + iso_amount * (gain * io_wet_r[i]);
        io_out_l[i] = soft_limit(ol);
        io_out_r[i] = soft_limit(or_);
    }
}

void isolate_set_amount(float a) {
    if (a < 0.0f) a = 0.0f;
    if (a > 1.0f) a = 1.0f;
    iso_amount = a;
}

void isolate_set_mode(int mode) {
    if (mode < 0 || mode >= ISO_MODE_COUNT) return;
    if (mode == iso_mode) return;
    iso_mode = mode;
    update_mask_coeffs();
    isolate_set_makeup_db(MODES[mode].makeup_db);
    /* Do NOT reset mask_state — the smoother re-converges within a few frames
     * and zeroing it would punch a hole in the audio on every mode change. */
}

void isolate_set_makeup_db(float db) {
    if (db < -24.0f) db = -24.0f;
    if (db > 24.0f) db = 24.0f;
    makeup_lin = powf(10.0f, db / 20.0f);
}

void isolate_set_auto_gain(int on) {
    auto_gain_on = on ? 1 : 0;
    if (!auto_gain_on) { agc_gain = 1.0f; agc_rms = 0.0f; }
}

void isolate_set_mono(int on) { iso_mono = on ? 1 : 0; }

/* Negative restores the mode's own value, matching isolate_set_smoothing_tau.
 * Deliberately does NOT reset the history: strength scales an already-computed
 * gain, so an A/B between 0 and 1 is instant rather than costing a 3 s warm-up
 * on every toggle. */
void isolate_set_repet(float strength) {
    if (strength > 1.0f) strength = 1.0f;
    rp_strength_override = (strength < 0.0f) ? -1.0f : strength;
}

/* Call on any discontinuity in the audio timeline — a seek, a track change, an
 * ad boundary. Without it the history spans two unrelated pieces of music and
 * the "background" is a median over a splice. */
void isolate_repet_reset(void) {
    rp_write = 0;
    rp_count = 0;
    rp_stride_ctr = 0;
    rp_search_ctr = 0;
    memset(rp_hnorm, 0, sizeof(rp_hnorm));
    for (int b = 0; b < RP_BANDS; b++) rp_gain[b] = 1.0f;
}

float isolate_get_flux(void) { return iso_frame_flux; }

int isolate_latency_samples(void) { return FFT_SIZE; }

/* Test hooks. Negative restores the mode's own value. iso_test.c uses these
 * for the musical-noise negative control (tau == 0 disables smoothing, which
 * must FAIL the flutter bound) and to force the mask fully open for the
 * perfect-reconstruction assertion. */
void isolate_set_smoothing_tau(float att, float rel) {
    att_tau_override = att;
    rel_tau_override = rel;
    update_mask_coeffs();
}

void isolate_set_mask_bypass(int on) { mask_bypass = on ? 1 : 0; }

void isolate_cleanup(void) {
    if (fft_fwd) { free(fft_fwd); fft_fwd = NULL; }
    if (fft_inv) { free(fft_inv); fft_inv = NULL; }
}
