/**
 * MorseDecoder.js — Main thread decoder.
 * Receives 100Hz feature stream (feat) from AudioWorklet, reconstructs
 * mark/gap durations from gate transitions, estimates unit time T via
 * quantization fit using both marks and gaps, and decodes Morse.
 */
export class MorseDecoder {
    constructor(audioCtx) {
        this.audioCtx = audioCtx;
        this.sampleRate = 44100;
        this.microphone = null;
        this.workletNode = null;
        this.isListening = false;

        // Callbacks for the UI
        this.onCharDecoded = null;
        this.onStatusChange = null;
        this.onLevelUpdate = null;

        // --- Decoder state (feat-driven) ---
        this._lastFeat = null;
        this._lastGate = false;
        this._lastGateTSamples = null; // sample timestamp of last gate transition
        this._inMark = false;          // true if currently in mark (tone)
        this._buffer = '';

        // Rolling duration window for unit-time (T) fitting
        this._durWin = [];             // ms durations, both marks & gaps
        this._durWinMax = 160;         // 100-200 requested

        // Unit-time estimate (ms)
        this.T = 120;                  // initial guess
        this._TValid = false;

        // Filtering / tolerances
        this._minDurMs = 18;           // ignore ultra-short glitches
        this._maxDurMs = 2500;         // ignore absurd outliers (helps fit)

        // UI cache
        this._uiLastSentMs = 0;

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
    }

    // --- Public API ---
    async start() {
        if (!this.audioCtx) return;
        this.sampleRate = this.audioCtx.sampleRate;

        try {
            await this.audioCtx.audioWorklet.addModule('/Morsefy/morse-detector.worklet.js');

            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            });

            this.microphone = this.audioCtx.createMediaStreamSource(stream);
            this.workletNode = new AudioWorkletNode(this.audioCtx, 'morse-detector');
            this.workletNode.port.onmessage = (e) => this._onWorkletMessage(e.data);
            this.microphone.connect(this.workletNode);

            // Reset state
            this._lastFeat = null;
            this._lastGate = false;
            this._lastGateTSamples = null;
            this._inMark = false;
            this._buffer = '';

            this._durWin = [];
            this.T = 120;
            this._TValid = false;

            this.isListening = true;
            if (this.onStatusChange) this.onStatusChange(true);
        } catch (e) {
            console.error('[MorseDecoder] start failed:', e);
            this.isListening = false;
        }
    }

    stop() {
        this.isListening = false;

        ['workletNode', 'microphone'].forEach(k => {
            if (this[k]) { this[k].disconnect(); this[k] = null; }
        });

        if (this.onStatusChange) this.onStatusChange(false);
        if (this.onLevelUpdate) this.onLevelUpdate({ level: 0, isTone: false, peakFreq: 0, threshold: '', buffer: '' });
    }

    // --- Worklet message handling ---
    _onWorkletMessage(data) {
        if (!this.isListening) return;

        if (data.type === 'feat') {
            this._handleFeat(data);
        }
        // on/off edges are also emitted by the worklet but feat is primary
    }

    _handleFeat(feat) {
        this._lastFeat = feat;

        const gate = !!feat.gate;
        const tS = feat.tSamples;

        // First sample: initialize
        if (this._lastGateTSamples === null) {
            this._lastGate = gate;
            this._lastGateTSamples = tS;
            this._inMark = gate;
            this._sendLevelUpdate();
            return;
        }

        // Detect gate transition
        if (gate !== this._lastGate) {
            const durMs = this._samplesToMs(tS - this._lastGateTSamples);
            const wasMark = this._lastGate; // previous state defines the completed segment

            this._lastGate = gate;
            this._lastGateTSamples = tS;
            this._inMark = gate;

            // Debounce / sanity bounds
            if (durMs >= this._minDurMs && durMs <= this._maxDurMs) {
                this._pushDuration(durMs);
                this._refitUnitTime();

                if (wasMark) {
                    // completed MARK -> classify dot/dash, append symbol
                    const sym = this._classifyMark(durMs);
                    if (sym) this._buffer += sym;
                } else {
                    // completed GAP -> commit char/word based on 3T / 7T
                    this._handleGapCommit(durMs);
                }
            }
        }

        this._sendLevelUpdate();
    }

    // --- Duration window & Unit-Time Quantization Fit ---
    _pushDuration(ms) {
        this._durWin.push(ms);
        if (this._durWin.length > this._durWinMax) this._durWin.shift();
    }

    _refitUnitTime() {
        // Needs enough data points to be stable
        if (this._durWin.length < 12) {
            this._TValid = false;
            return;
        }

        // Robust fit: scan candidate T and minimize quantization error
        // using expected unit set {1,3,7} (works with both marks and gaps)
        const units = [1, 3, 7];
        const data = this._durWin;
        const curT = this.T || 120;
        const Tmin = Math.max(20, curT * 0.6);
        const Tmax = Math.min(600, curT * 1.6);

        const step = Math.max(1, Math.round((Tmax - Tmin) / 140));

        let bestT = curT;
        let bestCost = Infinity;

        for (let T = Tmin; T <= Tmax; T += step) {
            let cost = 0;
            let used = 0;

            for (let i = 0; i < data.length; i++) {
                const d = data[i];

                // Find nearest expected unit multiple
                let bestU = 1;
                let bestErr = Infinity;
                for (let k = 0; k < units.length; k++) {
                    const u = units[k];
                    const err = Math.abs(d - u * T);
                    if (err < bestErr) { bestErr = err; bestU = u; }
                }

                // Normalize error: relative + small absolute component
                const rel = bestErr / Math.max(1, bestU * T);
                cost += rel * rel + (bestErr / 800) * (bestErr / 800);
                used++;
            }

            if (used > 0 && cost < bestCost) {
                bestCost = cost;
                bestT = T;
            }
        }

        // Smooth updates to avoid jitter
        const alpha = 0.25;
        this.T = this.T ? (this.T * (1 - alpha) + bestT * alpha) : bestT;

        // Validate: if fit is terrible, don't trust T for committing
        const costPer = bestCost / Math.max(1, data.length);
        this._TValid = (costPer < 0.20) && (this.T >= 20) && (this.T <= 600);
    }

    // --- Classification / commits ---
    _classifyMark(durMs) {
        const T = this.T || 120;
        const u = durMs / T;

        // Tolerance bands: dot 0.55–1.55T, dash 2.1–3.9T
        if (u >= 0.55 && u <= 1.55) return '.';
        if (u >= 2.1 && u <= 3.9) return '-';

        // Fallback: nearest of 1 vs 3
        if (u > 0.3 && u < 5.0) {
            const d1 = Math.abs(u - 1);
            const d3 = Math.abs(u - 3);
            return (d1 <= d3) ? '.' : '-';
        }

        return null;
    }

    _handleGapCommit(gapMs) {
        if (!this._buffer) return;

        const T = this.T || 120;
        const u = gapMs / T;

        // Commit thresholds: char at 3T, word at 7T
        // More conservative when T isn't validated yet
        const charGate = this._TValid ? 3.0 : 4.0;
        const wordGate = this._TValid ? 7.0 : 9.0;

        if (u >= wordGate) {
            this._decodeChar();
            if (this.onCharDecoded) this.onCharDecoded(' ');
            return;
        }

        if (u >= charGate) {
            this._decodeChar();
        }
    }

    _decodeChar() {
        if (!this._buffer) return;
        const char = this.MORSE_MAP[this._buffer];
        if (char && this.onCharDecoded) this.onCharDecoded(char);
        else console.log('[MorseDecoder] Unknown pattern:', this._buffer);
        this._buffer = '';
    }

    // --- UI / helpers ---
    _samplesToMs(samples) {
        return (samples / this.sampleRate) * 1000;
    }

    _estimateWpm() {
        // Standard PARIS: dot duration (seconds) = 1.2 / WPM
        const T = this.T || 120;
        const dotSec = T / 1000;
        if (dotSec <= 0) return 0;
        const wpm = 1.2 / dotSec;
        return Math.max(1, Math.min(80, wpm));
    }

    _sendLevelUpdate() {
        if (!this.onLevelUpdate) return;

        // Throttle to ~20Hz (feat is 100Hz)
        const now = performance.now();
        if (now - this._uiLastSentMs < 50) return;
        this._uiLastSentMs = now;

        const f = this._lastFeat || {};
        const wpm = this._estimateWpm();
        const T = this.T || 120;
        const dotMs = Math.round(T);
        const dashMs = Math.round(3 * T);

        this.onLevelUpdate({
            level: Math.max(0, Math.min(100, (f.snrDb || 0) * 3)),
            isTone: !!f.gate,
            peakFreq: f.f0 || 0,
            snrDb: f.snrDb || 0,
            tonDb: f.tonDb || 0,
            gate: !!f.gate,
            Ebf: f.Ebf || 0,
            Ebs: f.Ebs || 0,
            Ewf: f.Ewf || 0,
            threshold: `T=${dotMs}ms (·) ${dashMs}ms (-)  WPM≈${wpm.toFixed(1)}${this._TValid ? '' : ' (calibrating)'}`,
            buffer: this._buffer,
            wpm
        });
    }
}
