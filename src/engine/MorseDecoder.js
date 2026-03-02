/**
 * MorseDecoder.js — Main thread decoder.
 * Receives ON/OFF events from AudioWorklet, classifies pulses using
 * live dot-length estimation (median of 8 short pulses), and decodes Morse.
 */
export class MorseDecoder {
    constructor(audioCtx) {
        this.audioCtx = audioCtx;
        this.sampleRate = 44100; // Default; overwritten to audioCtx.sampleRate in start()

        this.microphone = null;
        this.workletNode = null;
        this.isListening = false;

        // Callbacks for the UI
        this.onCharDecoded = null;
        this.onStatusChange = null;
        this.onLevelUpdate = null;

        // State
        this._tOn = null;             // sample count when last ON fired
        this._silenceStart = null;    // ms timestamp when last OFF fired
        this._silenceMs = 0;
        this._buffer = '';
        this._charFired = false;
        this._wordFired = false;

        // Dot estimator: median of sliding window of short pulses
        this._shortPulses = [];        // window of the last 8 short durations
        this.dotMean = 200;            // Conservative seed (500ms charGapMs initially)

        // Last status values for UI
        this._lastLevel = 0;
        this._lastIsTone = false;
        this._lastNoise = { floor: 0, snr: 0, f0: 0, thr_on: 0 };

        this.MORSE_MAP = {
            '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E',
            '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
            '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O',
            '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
            '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y',
            '--..': 'Z', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
            '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
            '-----': '0', '.-.-.-': '.', '--..--': ',', '..--..': '?',
            '-....-': '-', '-..-.': '/', '-.-.--': '!'
        };

        this._rafId = null;
    }

    // ─── Derived thresholds (ratio-based, with hard minimums) ─────────────────

    get _dashThresholdMs() { return this.dotMean * 2.0; }
    // Hard floor of 500ms prevents premature decode before dotMean has calibrated
    get _charGapMs() { return Math.max(500, this.dotMean * 2.5); }
    get _wordGapMs() { return Math.max(1200, this.dotMean * 6.0); }

    // ─── Public API ──────────────────────────────────────────────────────────

    async start() {
        if (!this.audioCtx) return;
        // Update sample rate now that AudioContext is guaranteed to be initialized
        this.sampleRate = this.audioCtx.sampleRate;
        try {
            // Load the worklet module (public/ dir → served at /morse-detector.worklet.js)
            await this.audioCtx.audioWorklet.addModule('/Morsefy/morse-detector.worklet.js');

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            });

            this.microphone = this.audioCtx.createMediaStreamSource(stream);
            this.workletNode = new AudioWorkletNode(this.audioCtx, 'morse-detector');

            // Route messages from worklet
            this.workletNode.port.onmessage = (e) => this._onWorkletMessage(e.data);

            this.microphone.connect(this.workletNode);
            // Do NOT connect worklet to destination (we don't want to hear the mic)

            // Reset decoder state
            this._tOn = null;
            this._silenceStart = null;
            this._buffer = '';
            this._shortPulses = [];
            this.dotMean = 120;
            this._charFired = false;
            this._wordFired = false;

            this.isListening = true;
            this._startSilenceLoop();
            if (this.onStatusChange) this.onStatusChange(true);
        } catch (e) {
            console.error('[MorseDecoder] start failed:', e);
            this.isListening = false;
        }
    }

    stop() {
        this.isListening = false;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        ['workletNode', 'microphone'].forEach(k => {
            if (this[k]) { this[k].disconnect(); this[k] = null; }
        });
        if (this.onStatusChange) this.onStatusChange(false);
        if (this.onLevelUpdate) this.onLevelUpdate({ level: 0, isTone: false, peakFreq: 0, threshold: '0', buffer: '' });
    }

    // ─── Worklet message handler ──────────────────────────────────────────────

    _onWorkletMessage(data) {
        if (data.type === 'on') {
            this._tOn = data.tSamples;
            this._silenceStart = null;
            this._charFired = false;
            this._wordFired = false;
            this._lastIsTone = true;
            this._lastLevel = data.level;

        } else if (data.type === 'off') {
            if (this._tOn !== null) {
                const durationMs = (data.tSamples - this._tOn) / this.sampleRate * 1000;
                this._tOn = null;
                this._onTonePulse(durationMs);
            }
            this._silenceStart = performance.now();
            this._lastIsTone = false;
            this._lastLevel = data.level;

        } else if (data.type === 'noise') {
            this._lastNoise = data;
        }
    }

    // ─── Tone pulse processing ────────────────────────────────────────────────

    _onTonePulse(durationMs) {
        // Reject sub-20ms blips (below any meaningful Morse element)
        if (durationMs < 20) return;

        // Update dot estimator with this pulse if it looks like a dot
        this._updateDotEstimate(durationMs);

        // Classify pulse
        const symbol = (durationMs < this._dashThresholdMs) ? '.' : '-';
        this._buffer += symbol;
    }

    /**
     * Dot-length estimator using median of sliding window.
     * Window tracks the 8 most recent SHORT pulses (dots).
     * Median is robust to outlier dashes accidentally entering the window.
     */
    _updateDotEstimate(durationMs) {
        // Only add if below current dot/dash crossover (looks like a dot)
        if (this._shortPulses.length === 0 || durationMs < this._dashThresholdMs) {
            this._shortPulses.push(durationMs);
            if (this._shortPulses.length > 8) this._shortPulses.shift(); // sliding window
            this.dotMean = this._median(this._shortPulses);
            this.dotMean = Math.max(20, Math.min(600, this.dotMean));
            // Calibrated once we have seen at least 3 short pulses
            if (this._shortPulses.length >= 3) this._calibrated = true;
        }
    }

    _median(arr) {
        if (arr.length === 0) return this.dotMean;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // ─── Silence gap detection (runs in requestAnimationFrame) ────────────────

    _startSilenceLoop() {
        const tick = () => {
            if (!this.isListening) return;
            this._rafId = requestAnimationFrame(tick);

            // Update UI meter
            if (this.onLevelUpdate) {
                const n = this._lastNoise;
                const dotMs = Math.round(this.dotMean);
                const dashMs = Math.round(this.dotMean * 3);
                this.onLevelUpdate({
                    level: Math.min(100, (this._lastLevel / (n.thr_on || 0.01)) * 40),
                    isTone: this._lastIsTone,
                    peakFreq: n.f0 || 0,
                    threshold: `·${dotMs} -${dashMs}ms`,
                    buffer: this._buffer
                });
            }

            // Silence-based gap detection — only decode once calibrated
            if (!this._lastIsTone && this._silenceStart !== null && this._buffer !== '') {
                const silenceMs = performance.now() - this._silenceStart;

                // Gate: don't decode until dotMean is reliable (3+ short pulses seen)
                // OR until a very long absolute silence has elapsed (failsafe)
                const canDecode = this._calibrated || silenceMs > 1500;

                if (canDecode && silenceMs >= this._charGapMs && !this._charFired) {
                    this._decodeChar();
                    this._charFired = true;
                }
                if (canDecode && silenceMs >= this._wordGapMs && !this._wordFired) {
                    if (this.onCharDecoded) this.onCharDecoded(' ');
                    this._wordFired = true;
                }
            }
        };
        this._rafId = requestAnimationFrame(tick);
    }

    _decodeChar() {
        if (this._buffer === '') return;
        const char = this.MORSE_MAP[this._buffer];
        if (char && this.onCharDecoded) this.onCharDecoded(char);
        else console.log('[MorseDecoder] Unknown pattern:', this._buffer);
        this._buffer = '';
    }
}
