
import { MorseDecoder } from './src/engine/MorseDecoder.js';

// Mock AudioContext for testing
class MockAudioContext {
    constructor() {
        this.sampleRate = 44100;
    }
    createMediaStreamSource() { return { connect: () => { } }; }
    createAnalyser() {
        return {
            connect: () => { },
            getByteFrequencyData: (arr) => {
                // To be filled by test logic
            },
            frequencyBinCount: 1024,
            fftSize: 2048
        };
    }
}

async function testDecoder() {
    console.log("Starting MorseDecoder Diagnostic...");
    const ctx = new MockAudioContext();
    const decoder = new MorseDecoder(ctx);

    let decodedString = "";
    decoder.onCharDecoded = (char) => {
        decodedString += char;
        console.log(`[DECODER] Decoded: "${char}" -> Current: "${decodedString}"`);
    };

    // Manual test of handleCharEnd logic
    console.log("\nTest 1: Manual Morse Buffer Test");
    decoder.currentMorse = ".-"; // A
    decoder.handleCharEnd();
    console.log(`Expected 'A', got: '${decodedString}'`);

    decoder.currentMorse = "-..."; // B
    decoder.handleCharEnd();
    console.log(`Expected 'AB', got: '${decodedString}'`);

    // Reset for audio simulation
    decoder.decodedText = "";
    decodedString = "";

    console.log("\nTest 2: Timing Logic Investigation");
    // Simulate tone of 100ms (Dot)
    decoder.lastState = false;
    decoder.lastChangeTime = 0;

    const simulateTone = (duration, isTone, now) => {
        const magnitude = isTone ? 0.8 : 0.01;
        // Mocking the process logic internally or manually triggering parts
        if (isTone !== decoder.lastState) {
            const elapsed = now - decoder.lastChangeTime;
            if (decoder.lastState === true) {
                if (elapsed > decoder.dotMin) {
                    decoder.currentMorse += (elapsed < decoder.dashMin) ? "." : "-";
                }
            } else {
                if (elapsed > 200) {
                    decoder.handleCharEnd();
                }
            }
            decoder.lastState = isTone;
            decoder.lastChangeTime = now;
        }
    };

    simulateTone(100, true, 100); // Start tone
    simulateTone(100, false, 200); // End tone (Dot)
    console.log(`Current Morse: ${decoder.currentMorse} (Expected '.')`);

    simulateTone(100, true, 400); // Start gap (200ms)
    simulateTone(300, true, 400); // Start dash
    simulateTone(300, false, 700); // End dash
    console.log(`Current Morse: ${decoder.currentMorse} (Expected '.-')`);

    // Simulate silence for char end
    decoder.handleCharEnd();
    console.log(`Decoded string: ${decodedString} (Expected 'A')`);
}

testDecoder();
