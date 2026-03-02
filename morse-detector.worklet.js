/**
 * morse-detector.worklet.js
 * AudioWorklet Processor — Redesigned DSP pipeline:
 *  1. RBJ Biquad bandpass at tracked f0 (default 700 Hz, Q=10)
 *  2. Fast/Slow EMA power tracking (band + wideband)
 *  3. SNR(dB) = 10·log10(Eband_fast / Eband_slow)
 *  4. Tonality(dB) = 10·log10(Eband_fast / Ewide_fast)
 *  5. Hysteresis gate with hang + min mark/gap constraints
 *  6. 100 Hz feature stream output for main thread consumption
 */

// RBJ cookbook biquad, Direct Form II Transposed (stable, fast)
class Biquad {
    constructor() {
        this.b0 = 1; this.b1 = 0; this.b2 = 0;
        this.a1 = 0; this.a2 = 0;
        this.z1 = 0; this.z2 = 0;
    }

    // Band-pass (constant skirt gain, peak gain = Q)
    // https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html
    setBandpass(fs, f0, Q) {
        const w0 = 2 * Math.PI * (f0 / fs);
        const cosw0 = Math.cos(w0);
        const sinw0 = Math.sin(w0);
        const alpha = sinw0 / (2 * Q);

        let b0 = alpha;
        let b1 = 0;
        let b2 = -alpha;
        let a0 = 1 + alpha;
        let a1 = -2 * cosw0;
        let a2 = 1 - alpha;

        this.b0 = b0 / a0;
        this.b1 = b1 / a0;
        this.b2 = b2 / a0;
        this.a1 = a1 / a0;
        this.a2 = a2 / a0;
    }

    processSample(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
    }
}

// Simple one-pole high-pass for wideband power (kills DC/rumble)
class OnePoleHP {
    constructor() {
        this.a = 0;
        this.y1 = 0;
        this.x1 = 0;
    }
    setHighpass(fs, fc) {
        this.a = Math.exp(-2 * Math.PI * (fc / fs));
    }
    processSample(x) {
        const y = this.a * (this.y1 + x - this.x1);
        this.y1 = y;
        this.x1 = x;
        return y;
    }
}

function emaAlphaFromTau(fs, tauSeconds) {
    return Math.exp(-1 / (tauSeconds * fs));
}

class MorseDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.fs = sampleRate;

        // --- Bandpass ---
        this.bp = new Biquad();
        this.bpCenterHz = 700;
        this.bpQ = 10;
        this.bp.setBandpass(this.fs, this.bpCenterHz, this.bpQ);

        // --- Wideband high-pass (DC removal for tonality) ---
        this.hp = new OnePoleHP();
        this.hp.setHighpass(this.fs, 120);

        // --- Power EMAs ---
        this.aBandFast = emaAlphaFromTau(this.fs, 0.005);  // 5ms
        this.aBandSlow = emaAlphaFromTau(this.fs, 0.250);  // 250ms
        this.aWideFast = emaAlphaFromTau(this.fs, 0.005);   // 5ms

        this.EbandFast = 0;
        this.EbandSlow = 0;
        this.EwideFast = 0;

        // --- Feature smoothing (20ms) ---
        this.aFeatSmooth = emaAlphaFromTau(this.fs, 0.020);
        this.snrDbSm = -120;
        this.tonDbSm = -120;

        // --- 100 Hz feature tick ---
        this.tickSamples = Math.round(this.fs / 100);
        this.tickAccum = 0;

        // --- Gate thresholds (dB) ---
        this.SNR_ON_DB = 8.0;
        this.SNR_OFF_DB = 4.0;
        this.TON_ON_DB = 7.0;
        this.TON_OFF_DB = 4.0;

        // --- Gate timing constraints (sample-based) ---
        this.minMarkSamples = Math.round(this.fs * 0.015); // 15ms
        this.minGapSamples = Math.round(this.fs * 0.015); // 15ms
        this.hangSamples = Math.round(this.fs * 0.008);  // 8ms

        this.gateOn = false;
        this.stateStartSample = 0;
        this.lastAboveOnSample = 0;
        this.pendingFlip = null;

        this.eps = 1e-12;

        // --- Listen for parameter updates from main thread ---
        this.port.onmessage = (e) => {
            const msg = e.data;
            if (msg && msg.type === 'setTone' && typeof msg.hz === 'number') {
                const hz = Math.max(200, Math.min(2000, msg.hz));
                this.bpCenterHz = hz;
                this.bp.setBandpass(this.fs, this.bpCenterHz, this.bpQ);
            }
            if (msg && msg.type === 'setThresholds') {
                if (typeof msg.snrOn === 'number') this.SNR_ON_DB = msg.snrOn;
                if (typeof msg.snrOff === 'number') this.SNR_OFF_DB = msg.snrOff;
                if (typeof msg.tonOn === 'number') this.TON_ON_DB = msg.tonOn;
                if (typeof msg.tonOff === 'number') this.TON_OFF_DB = msg.tonOff;
            }
        };
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const ch = input[0];
        const n = ch.length;
        const blockStart = currentFrame;

        for (let i = 0; i < n; i++) {
            const x0 = ch[i];

            // Wideband path (HP to avoid DC dominating)
            const xWide = this.hp.processSample(x0);

            // Bandpass path
            const xBand = this.bp.processSample(x0);

            // Instant power
            const pBand = xBand * xBand;
            const pWide = xWide * xWide;

            // EMAs
            this.EbandFast = this.aBandFast * this.EbandFast + (1 - this.aBandFast) * pBand;
            this.EbandSlow = this.aBandSlow * this.EbandSlow + (1 - this.aBandSlow) * pBand;
            this.EwideFast = this.aWideFast * this.EwideFast + (1 - this.aWideFast) * pWide;

            // 100Hz tick
            this.tickAccum++;

            if (this.tickAccum >= this.tickSamples) {
                const tSamples = blockStart + i;

                // Features (dB)
                const snrDb = 10 * Math.log10((this.EbandFast + this.eps) / (this.EbandSlow + this.eps));
                const tonDb = 10 * Math.log10((this.EbandFast + this.eps) / (this.EwideFast + this.eps));

                // Smooth features
                this.snrDbSm = this.aFeatSmooth * this.snrDbSm + (1 - this.aFeatSmooth) * snrDb;
                this.tonDbSm = this.aFeatSmooth * this.tonDbSm + (1 - this.aFeatSmooth) * tonDb;

                // --- Boolean gating ---
                const wantOn =
                    (this.snrDbSm >= this.SNR_ON_DB) && (this.tonDbSm >= this.TON_ON_DB);
                const wantOff =
                    (this.snrDbSm <= this.SNR_OFF_DB) || (this.tonDbSm <= this.TON_OFF_DB);

                // Hang logic
                if (wantOn) this.lastAboveOnSample = tSamples;

                const stateDur = tSamples - this.stateStartSample;

                // Flip decisions with min durations + hang
                if (!this.gateOn) {
                    if (wantOn) {
                        if (!this.pendingFlip || this.pendingFlip.toOn !== true) {
                            this.pendingFlip = { toOn: true, sinceSample: tSamples };
                        }
                        const pendingDur = tSamples - this.pendingFlip.sinceSample;
                        if (pendingDur >= this.minGapSamples) {
                            this.gateOn = true;
                            this.stateStartSample = tSamples;
                            this.pendingFlip = null;
                            this.port.postMessage({ type: 'on', tSamples });
                        }
                    } else {
                        this.pendingFlip = null;
                    }
                } else {
                    const sinceAbove = tSamples - this.lastAboveOnSample;
                    const hangExpired = sinceAbove >= this.hangSamples;

                    if (wantOff && hangExpired) {
                        if (!this.pendingFlip || this.pendingFlip.toOn !== false) {
                            this.pendingFlip = { toOn: false, sinceSample: tSamples };
                        }
                        const pendingDur = tSamples - this.pendingFlip.sinceSample;
                        if (stateDur >= this.minMarkSamples && pendingDur >= this.minMarkSamples) {
                            this.gateOn = false;
                            this.stateStartSample = tSamples;
                            this.pendingFlip = null;
                            this.port.postMessage({ type: 'off', tSamples });
                        }
                    } else {
                        this.pendingFlip = null;
                    }
                }

                // --- Feature stream at 100 Hz ---
                this.port.postMessage({
                    type: 'feat',
                    tSamples,
                    snrDb: this.snrDbSm,
                    tonDb: this.tonDbSm,
                    gate: this.gateOn,
                    Ebf: this.EbandFast,
                    Ebs: this.EbandSlow,
                    Ewf: this.EwideFast,
                    f0: this.bpCenterHz
                });

                this.tickAccum = 0;
            }
        }

        return true;
    }
}

registerProcessor('morse-detector', MorseDetectorProcessor);
