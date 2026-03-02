/**
 * morse-detector.worklet.js
 * AudioWorklet Processor — DSP pipeline:
 *  1. FFT peak tracking (every ~32 quanta = ~93ms) → f0
 *  2. Goertzel at f0 and f0±20Hz (per 128-sample quantum)
 *  3. Envelope follower (IIR: fast attack, slower release)
 *  4. Adaptive noise floor (computed only while gate is OFF)
 *  5. Hysteresis gate + edge detector → posts ON/OFF messages with sample timestamps
 */
class MorseDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.sampleRate = 44100; // will be updated from AudioWorkletGlobalScope

        // === FFT peak tracker state ===
        this.fftSize = 512;
        this.fftHopQuanta = 32;     // update f0 every 32 quanta (~93ms at 44.1kHz)
        this.fftBuf = new Float64Array(this.fftSize);
        this.fftBufIdx = 0;
        this.fftQuantaCount = 0;
        this.f0 = 700;              // current tracked frequency (Hz)
        this.f0Smooth = 700;

        // === Goertzel state ===
        this.goertzelFreqs = [700, 680, 720]; // f0, f0-20, f0+20 — updated on each FFT tick
        this.N_goertzel = 128;

        // === Envelope follower ===
        this.env = 0;
        this.ALPHA_ATTACK = 0.60; // per 2.9ms quantum
        this.ALPHA_RELEASE = 0.15;

        // === Adaptive noise floor ===
        this.noiseFloor = 0.0001;
        this.ALPHA_NOISE = 0.005;   // ~5s time constant
        this.MIN_FLOOR = 0.00001;

        // === Hysteresis gate ===
        this.THR_ON_RATIO = 5.0;
        this.THR_OFF_RATIO = 2.5;
        this.MIN_ON_QUANTA = 8;     // ~23ms glitch filter

        this.gateOn = false;
        this.pendingOnQuanta = 0;
        this.tOnSamples = 0;        // sample offset of last ON edge

        // === Circular audio buffer for FFT ===
        this.circBuf = new Float32Array(this.fftSize);
        this.circIdx = 0;

        // Listen for parameter updates from main thread
        this.port.onmessage = (e) => {
            if (e.data.type === 'setF0') {
                // Not used here — f0 is tracked internally, but we allow override
                this.f0 = e.data.f0;
                this.f0Smooth = e.data.f0;
                this._updateGoertzelFreqs();
            } else if (e.data.type === 'setParams') {
                if (e.data.threshold_snr) this.THR_ON_RATIO = e.data.threshold_snr;
                if (e.data.hysteresis_ratio) this.THR_OFF_RATIO = e.data.threshold_snr / e.data.hysteresis_ratio;
            }
        };
    }

    _updateGoertzelFreqs() {
        this.goertzelFreqs = [this.f0Smooth, this.f0Smooth - 20, this.f0Smooth + 20];
    }

    /**
     * Goertzel algorithm for a single frequency bin.
     * Returns normalized power for the given block.
     */
    _goertzel(samples, freq, sr) {
        const N = samples.length;
        const k = Math.round(freq * N / sr);
        const omega = (2 * Math.PI * k) / N;
        const coeff = 2 * Math.cos(omega);

        let s0 = 0, s1 = 0, s2 = 0;
        for (let i = 0; i < N; i++) {
            s0 = samples[i] + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        // Power (normalized to [0,~1] for unit-amplitude sine wave)
        const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (N * N * 0.25);
        return Math.max(0, power);
    }

    /**
     * Simplified DFT magnitude peak search in [300,1200] Hz range.
     * Uses only the FFT circular buffer (512-pt DFT via magnitude scan).
     * Runs every ~93ms (32 quanta).
     */
    _updateFFTPeak(sr) {
        const N = this.fftSize;
        const binMin = Math.floor(300 * N / sr);
        const binMax = Math.ceil(1200 * N / sr);

        // Compute DFT magnitudes only for target bins (Goertzel per bin)
        let peakPow = 0;
        let peakFreq = this.f0Smooth;

        for (let bin = binMin; bin <= binMax; bin++) {
            const freq = bin * sr / N;
            const pow = this._goertzel(this.circBuf, freq, sr);
            if (pow > peakPow) {
                peakPow = pow;
                peakFreq = freq;
            }
        }

        // IIR smooth the f0 to prevent jitter
        this.f0Smooth = 0.80 * this.f0Smooth + 0.20 * peakFreq;
        this._updateGoertzelFreqs();
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const sr = sampleRate; // AudioWorkletGlobalScope global
        const channel = input[0];
        const nSamples = channel.length; // always 128

        // Add to circular buffer for FFT
        for (let i = 0; i < nSamples; i++) {
            this.circBuf[this.circIdx] = channel[i];
            this.circIdx = (this.circIdx + 1) % this.fftSize;
        }

        // FFT peak update every fftHopQuanta quanta
        this.fftQuantaCount++;
        if (this.fftQuantaCount >= this.fftHopQuanta) {
            this.fftQuantaCount = 0;
            // Linearize circular buffer
            const linBuf = new Float32Array(this.fftSize);
            for (let i = 0; i < this.fftSize; i++) {
                linBuf[i] = this.circBuf[(this.circIdx + i) % this.fftSize];
            }
            this._updateFFTPeak(sr);
        }

        // Goertzel over this 128-sample quantum at tracked f0 (and ±20Hz)
        let maxPower = 0;
        for (const freq of this.goertzelFreqs) {
            const pow = this._goertzel(channel, freq, sr);
            if (pow > maxPower) maxPower = pow;
        }

        // Envelope follower (IIR)
        const alpha = maxPower > this.env ? this.ALPHA_ATTACK : this.ALPHA_RELEASE;
        this.env = alpha * maxPower + (1 - alpha) * this.env;

        // Noise floor (only tracked during silence)
        if (!this.gateOn) {
            this.noiseFloor = this.ALPHA_NOISE * this.env + (1 - this.ALPHA_NOISE) * this.noiseFloor;
            this.noiseFloor = Math.max(this.MIN_FLOOR, this.noiseFloor);
        }

        const thr_on = this.noiseFloor * this.THR_ON_RATIO;
        const thr_off = this.noiseFloor * this.THR_OFF_RATIO;

        // Hysteresis gate
        if (!this.gateOn) {
            if (this.env > thr_on) {
                this.pendingOnQuanta++;
                if (this.pendingOnQuanta >= this.MIN_ON_QUANTA) {
                    // Rising edge confirmed
                    this.gateOn = true;
                    // Timestamp adjusted back to start of pending window
                    this.tOnSamples = currentFrame - (this.MIN_ON_QUANTA - 1) * nSamples;
                    this.port.postMessage({
                        type: 'on',
                        tSamples: this.tOnSamples,
                        f0: Math.round(this.f0Smooth),
                        level: this.env,
                        floor: this.noiseFloor,
                        snr: this.env / this.noiseFloor
                    });
                }
            } else {
                this.pendingOnQuanta = 0;
            }
        } else {
            if (this.env < thr_off) {
                // Falling edge
                this.gateOn = false;
                this.pendingOnQuanta = 0;
                this.port.postMessage({
                    type: 'off',
                    tSamples: currentFrame,
                    f0: Math.round(this.f0Smooth),
                    level: this.env,
                    floor: this.noiseFloor,
                    snr: this.env / this.noiseFloor
                });
            }
        }

        // Periodic noise floor report (~1/s)
        if (this.fftQuantaCount === 0) {
            this.port.postMessage({
                type: 'noise',
                floor: this.noiseFloor,
                snr: this.env / this.noiseFloor,
                f0: Math.round(this.f0Smooth),
                thr_on,
                thr_off,
                env: this.env
            });
        }

        return true; // keep processor alive
    }
}

registerProcessor('morse-detector', MorseDetectorProcessor);
