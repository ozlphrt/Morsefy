/**
 * Morse Engine - Handles Web Audio API Synthesis
 */

export const MORSE_MAP = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.',
    'G': '--.', 'H': '....', 'I': '..', 'J': '.---', 'K': '-.-', 'L': '.-..',
    'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.',
    'S': '...', 'T': '-', 'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-',
    'Y': '-.--', 'Z': '--..', '1': '.----', '2': '..---', '3': '...--',
    '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..',
    '9': '----.', '0': '-----', '.': '.-.-.-', ',': '--..--', '?': '..--..',
    '/': '-..-.', '@': '.--.-.', ' ': ' '
};

class MorseEngine {
    constructor() {
        this.audioCtx = null;
        this.oscillator = null;
        this.gainNode = null;
        this.frequency = 700; // Hz

        // Callbacks for visual feedback
        this.onSignalStart = null;
        this.onSignalEnd = null;
    }

    async init() {
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            this.audioCtx.onstatechange = () => {
                console.log(`[MorseEngine] AudioContext state: ${this.audioCtx.state}`);
            };

            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = 0;
            this.gainNode.connect(this.audioCtx.destination);
        }

        if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
            try {
                await this.audioCtx.resume();
                console.log('[MorseEngine] AudioContext resumed successfully');
            } catch (e) {
                console.error('[MorseEngine] Failed to resume AudioContext:', e);
            }
        }
    }

    async ensureAudioActive() {
        await this.init();
    }

    async playCharacter(char, wpm = 20, farnsworth = null) {
        await this.init();
        const code = MORSE_MAP[char.toUpperCase()];
        if (!code) return;

        // Timing constants (in seconds)
        // Standard PARIS timing: 1 dit = 1.2 / WPM
        const dotDuration = 1.2 / wpm;
        const dashDuration = dotDuration * 3;
        const intraSymbolGap = dotDuration;

        // Farnsworth timing
        // If farnsworth is set, we use standard dot duration for the symbols,
        // but the gap between characters is larger.
        const charGap = farnsworth ? (1.2 / farnsworth) * 3 : dotDuration * 3;

        for (let i = 0; i < code.length; i++) {
            const symbol = code[i];
            if (symbol === ' ') {
                await this.sleep(charGap);
                continue;
            }

            const duration = symbol === '.' ? dotDuration : dashDuration;

            if (this.onSignalStart) this.onSignalStart();
            this.beep(duration);
            await this.sleep(duration);
            if (this.onSignalEnd) this.onSignalEnd();

            if (i < code.length - 1) {
                await this.sleep(intraSymbolGap);
            }
        }
    }

    beep(duration) {
        const osc = this.audioCtx.createOscillator();
        const g = this.audioCtx.createGain();

        const now = this.audioCtx.currentTime;
        const attack = 0.005;
        const release = 0.005;

        osc.type = 'sine';
        osc.frequency.setValueAtTime(this.frequency, now);

        // Standard Morse Envelope: Attack -> Hold -> Release
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.1, now + attack);
        g.gain.setValueAtTime(0.1, now + duration - release);
        g.gain.linearRampToValueAtTime(0, now + duration);

        osc.connect(g);
        g.connect(this.audioCtx.destination);

        osc.start();
        osc.stop(this.audioCtx.currentTime + duration);
    }

    async warmUp() {
        await this.init();
        // Play a very short silent note to "wake up" the sound card
        const osc = this.audioCtx.createOscillator();
        const g = this.audioCtx.createGain();
        g.gain.setValueAtTime(0, this.audioCtx.currentTime);
        osc.connect(g);
        g.connect(this.audioCtx.destination);
        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.1);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms * 1000));
    }
}

export const morseEngine = new MorseEngine();
