/**
 * morse-worklet.js — tone-gate-processor AudioWorklet
 *
 * Pipeline:
 *   mic input → FFT peak tracker (300–1200 Hz, 4096-pt Hann) → f0
 *   → Goertzel at f0, f0±25Hz → toneness metric
 *   → EMA envelope → adaptive noise floor
 *   → hysteresis gate → ON/OFF transitions with sample timestamps
 *
 * All timing decisions are in samples. No setTimeout/setInterval.
 */

// ---------------------------------------------------------------------------
// Cooley-Tukey radix-2 FFT (in-place, DIF)
// re[], im[] must be length == power of 2
// ---------------------------------------------------------------------------
function fftInPlace(re, im) {
    const N = re.length;
    // Bit-reversal
    let j = 0;
    for (let i = 1; i < N; i++) {
        let bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    // Butterfly stages
    for (let len = 2; len <= N; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wCos = Math.cos(ang), wSin = Math.sin(ang);
        for (let i = 0; i < N; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < (len >> 1); k++) {
                const ur = re[i + k], ui = im[i + k];
                const vr = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
                const vi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + (len >> 1)] = ur - vr; im[i + k + (len >> 1)] = ui - vi;
                const ncr = cr * wCos - ci * wSin;
                ci = cr * wSin + ci * wCos;
                cr = ncr;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Goertzel DFT at a single real frequency bin
// Returns energy (magnitude²) at frequency `freq` over `samples`
// ---------------------------------------------------------------------------
function goertzel(samples, freq, sampleRate) {
    const N = samples.length;
    const k = (freq * N) / sampleRate;
    const omega = (2 * Math.PI * k) / N;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
        s0 = samples[i] + coeff * s1 - s2;
        s2 = s1; s1 = s0;
    }
    // Power: avoid sqrt, normalize by N²/4 to get approximate unit energy
    return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (N * N * 0.25);
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------
class ToneGateProcessor extends AudioWorkletProcessor {

    constructor(options) {
        super(options);

        // Global sample counter (sample-accurate timing)
        this.sampleCounter = 0;

        // Configurable params (updated via port messages)
        this.K = 3.0;   // noise × K = threshold
        this.F_MIN = 300;
        this.F_MAX = 1200;

        // ── FFT peak tracker ──────────────────────────────────────────────
        this.FFT_SIZE = 4096;
        this.HOP_SIZE = 1024; // 75% overlap → update every 1024 samples
        this.hopAccum = 0;    // samples accumulated since last FFT

        // Circular buffer for FFT input (float32, FFT_SIZE)
        this.fftCirBuf = new Float32Array(this.FFT_SIZE);
        this.fftCirIdx = 0;

        // Pre-compute Hann window
        this.hannFFT = new Float32Array(this.FFT_SIZE);
        for (let i = 0; i < this.FFT_SIZE; i++)
            this.hannFFT[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.FFT_SIZE - 1)));

        // FFT working arrays (Float64 for precision)
        this.fftRe = new Float64Array(this.FFT_SIZE);
        this.fftIm = new Float64Array(this.FFT_SIZE);

        // Tracked frequency
        this.f0 = 700; // Hz, smoothed

        // ── Goertzel tone detector ────────────────────────────────────────
        this.GOERTZEL_N = 2048;
        this.GOERTZEL_HOP = 1024; // 50% overlap
        this.gzCirBuf = new Float32Array(this.GOERTZEL_N);
        this.gzCirIdx = 0;
        this.gzHopAccum = 0;
        this.gzBlock = new Float32Array(this.GOERTZEL_N); // linearized snapshot

        // ── Envelope + noise floor ────────────────────────────────────────
        this.env = 0;
        this.noise = 0.0001;
        this.ALPHA_ENV = 0.2;
        this.ALPHA_NOISE_OFF = 0.02;
        this.ALPHA_NOISE_ON = 0.002;
        this.toneness = 1.0;
        this.lastEnergy = 0;

        // ── Hysteresis gate ───────────────────────────────────────────────
        this.gateOn = false;
        // Min ON / OFF in samples (2ms at 44100 → 88 samples)
        this.minPulseSmp = Math.round(0.002 * sampleRate);
        this.gateFlipAt = 0; // sample counter when gate last flipped

        // Pending gate state (must sustain minPulseSmp before committing)
        this.pendingState = false;
        this.pendingStart = 0;
        this.pendingActive = false;

        // ── Status reporter ───────────────────────────────────────────────
        this.statusInterval = Math.round(0.200 * sampleRate); // 200ms
        this.statusAccum = 0;

        // ── Message handler ───────────────────────────────────────────────
        this.port.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'setParams') {
                if (d.K !== undefined) this.K = d.K;
                if (d.fMin !== undefined) this.F_MIN = d.fMin;
                if (d.fMax !== undefined) this.F_MAX = d.fMax;
            }
        };
    }

    // ── FFT peak tracker ──────────────────────────────────────────────────────
    _updateF0() {
        // Linearize circular buffer into fftRe (windowed), fftIm = 0
        for (let i = 0; i < this.FFT_SIZE; i++) {
            const idx = (this.fftCirIdx + i) % this.FFT_SIZE;
            this.fftRe[i] = this.fftCirBuf[idx] * this.hannFFT[i];
            this.fftIm[i] = 0;
        }

        fftInPlace(this.fftRe, this.fftIm);

        // Search for peak in [F_MIN, F_MAX]
        const binMin = Math.ceil(this.F_MIN * this.FFT_SIZE / sampleRate);
        const binMax = Math.floor(this.F_MAX * this.FFT_SIZE / sampleRate);

        let peakMag = -1, peakBin = binMin;
        for (let k = binMin; k <= binMax; k++) {
            const mag = this.fftRe[k] * this.fftRe[k] + this.fftIm[k] * this.fftIm[k];
            if (mag > peakMag) { peakMag = mag; peakBin = k; }
        }

        // Parabolic interpolation for sub-bin precision
        let fPeak = peakBin * sampleRate / this.FFT_SIZE;
        if (peakBin > binMin && peakBin < binMax) {
            const mL = Math.sqrt(this.fftRe[peakBin - 1] ** 2 + this.fftIm[peakBin - 1] ** 2);
            const mC = Math.sqrt(this.fftRe[peakBin] ** 2 + this.fftIm[peakBin] ** 2);
            const mR = Math.sqrt(this.fftRe[peakBin + 1] ** 2 + this.fftIm[peakBin + 1] ** 2);
            const denom = mL - 2 * mC + mR;
            if (Math.abs(denom) > 1e-10) {
                const delta = 0.5 * (mL - mR) / denom;
                fPeak = (peakBin + delta) * sampleRate / this.FFT_SIZE;
            }
        }

        // Smooth f0
        this.f0 = 0.85 * this.f0 + 0.15 * fPeak;
    }

    // ── Goertzel tone detector ────────────────────────────────────────────────
    _updateToneness() {
        // Linearize circular buffer
        for (let i = 0; i < this.GOERTZEL_N; i++) {
            this.gzBlock[i] = this.gzCirBuf[(this.gzCirIdx + i) % this.GOERTZEL_N];
        }

        const f0 = this.f0;
        const EPS = 1e-12;
        const Ec = goertzel(this.gzBlock, f0, sampleRate);
        const El = goertzel(this.gzBlock, f0 - 25, sampleRate);
        const Er = goertzel(this.gzBlock, f0 + 25, sampleRate);

        const Etotal = Ec + El + Er;
        this.toneness = Ec / (El + Er + EPS);
        this.lastEnergy = Etotal;

        // Update envelope (EMA on total energy)
        this.env = this.ALPHA_ENV * Etotal + (1 - this.ALPHA_ENV) * this.env;

        // Adaptive noise floor
        const alphaNoise = this.gateOn ? this.ALPHA_NOISE_ON : this.ALPHA_NOISE_OFF;
        this.noise = alphaNoise * this.env + (1 - alphaNoise) * this.noise;
        this.noise = Math.max(this.noise, 1e-10);
    }

    // ── Gate logic ────────────────────────────────────────────────────────────
    _updateGate() {
        const thr = this.noise * this.K;
        const wantOn = (this.env > thr * 1.15) && (this.toneness > 1.3);
        const wantOff = (this.env < thr * 0.85) || (this.toneness < 1.1);

        // Minimum pulse filter: require minPulseSmp samples before committing
        const desired = this.gateOn ? !wantOff : wantOn;

        if (desired !== this.gateOn) {
            if (!this.pendingActive || this.pendingState !== desired) {
                // New candidate
                this.pendingState = desired;
                this.pendingStart = this.sampleCounter;
                this.pendingActive = true;
            } else if (this.sampleCounter - this.pendingStart >= this.minPulseSmp) {
                // Sustained long enough → commit
                this.gateOn = desired;
                this.pendingActive = false;

                this.port.postMessage({
                    type: 'transition',
                    state: this.gateOn ? 'on' : 'off',
                    tSamples: this.pendingStart, // use start of pending (more accurate)
                    f0: Math.round(this.f0),
                    env: this.env,
                    noise: this.noise,
                    toneness: this.toneness
                });
            }
        } else {
            this.pendingActive = false;
        }
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const ch = input[0]; // Float32Array, length 128

        for (let i = 0; i < ch.length; i++) {
            const s = ch[i];

            // Push into FFT circular buffer
            this.fftCirBuf[this.fftCirIdx] = s;
            this.fftCirIdx = (this.fftCirIdx + 1) % this.FFT_SIZE;

            // Push into Goertzel circular buffer
            this.gzCirBuf[this.gzCirIdx] = s;
            this.gzCirIdx = (this.gzCirIdx + 1) % this.GOERTZEL_N;

            this.sampleCounter++;
            this.hopAccum++;
            this.gzHopAccum++;
            this.statusAccum++;

            // FFT peak tracker: update every HOP_SIZE samples
            if (this.hopAccum >= this.HOP_SIZE) {
                this.hopAccum = 0;
                this._updateF0();
            }

            // Goertzel detector: update every GOERTZEL_HOP samples
            if (this.gzHopAccum >= this.GOERTZEL_HOP) {
                this.gzHopAccum = 0;
                this._updateToneness();
                this._updateGate();
            }

            // Status report every ~200ms
            if (this.statusAccum >= this.statusInterval) {
                this.statusAccum = 0;
                this.port.postMessage({
                    type: 'status',
                    f0: Math.round(this.f0),
                    env: this.env,
                    noise: this.noise,
                    thr: this.noise * this.K,
                    toneness: this.toneness,
                    gateOn: this.gateOn
                });
            }
        }

        return true; // keep alive
    }
}

registerProcessor('tone-gate-processor', ToneGateProcessor);
