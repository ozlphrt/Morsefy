/**
 * Training Engine - Handles Koch progression and Spaced Repetition
 */

export const KOCH_ORDER = "KMRSTUALOIP.EGHCYQXWVBZF0987654321/?";

class TrainingEngine {
    constructor(stateManager) {
        this.sm = stateManager;
    }

    getNextCharacter() {
        const { unlockedChars } = this.sm.state.progress;
        // For MVP, if we want to add a character, we just pick the next in KOCH_ORDER
        if (unlockedChars.length < KOCH_ORDER.length) {
            return KOCH_ORDER[unlockedChars.length];
        }
        return null;
    }

    generateSession(count = 20) {
        const { unlockedChars } = this.sm.state.progress;
        const session = [];

        for (let i = 0; i < count; i++) {
            const char = this.weightedPick(unlockedChars);
            session.push(char);
        }

        return session;
    }

    weightedPick(chars) {
        const weights = chars.map(char => {
            const stats = this.sm.state.stats[char];
            if (!stats) return 2.0; // High priority for never-seen characters

            const accuracy = stats.correct / stats.attempts;
            const avgTime = stats.totalTime / stats.attempts;
            const timeFactor = Math.min(avgTime / 3000, 1);

            // Spaced Repetition Component:
            // How long since last seen? (in minutes)
            const msSinceLast = Date.now() - stats.lastSeen;
            const minsSinceLast = msSinceLast / (1000 * 60);

            // Decay factor: the longer it's been, the higher the weight
            // Especially if accuracy is low
            const recencyWeight = Math.min(minsSinceLast / 60, 2); // Cap at 2 hours

            // Final weight formula: 
            // - Low accuracy increases weight
            // - High response time increases weight
            // - Longer time since last seen increases weight
            return (1 - accuracy) * 2 + timeFactor + recencyWeight + 0.1;
        });

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let rand = Math.random() * totalWeight;

        for (let i = 0; i < weights.length; i++) {
            rand -= weights[i];
            if (rand <= 0) return chars[i];
        }
        return chars[chars.length - 1];
    }

    evaluateMastery(char) {
        const stats = this.sm.state.stats[char];
        if (!stats || stats.attempts < 20) return 'None';

        const accuracy = stats.correct / stats.attempts;
        if (accuracy >= 0.95 && stats.attempts >= 120) return 'Operator';
        if (accuracy >= 0.93 && stats.attempts >= 80) return 'Gold';
        if (accuracy >= 0.90 && stats.attempts >= 40) return 'Silver';
        if (accuracy >= 0.80 && stats.attempts >= 20) return 'Bronze';

        return 'None';
    }

    checkUnlockProgress() {
        const { history, unlockedChars } = this.sm.state.progress;

        // Need at least 60 attempts in history to evaluate (previously 30)
        if (history.length < 60) return { status: 'same' };

        // Calculate accuracy of the last 60 attempts
        const recent = history.slice(-60);
        const correct = recent.reduce((a, b) => a + b, 0);
        const accuracy = correct / recent.length;

        // Level Up: Accuracy >= 96% (only ~2 errors allowed in 60 attempts)
        if (accuracy >= 0.96) {
            const next = this.unlockNext();
            return next ? { status: 'unlocked', char: next } : { status: 'same' };
        }

        // Regression: Accuracy < 75% over last 40 attempts
        const regRecent = history.slice(-40);
        const regCorrect = regRecent.reduce((a, b) => a + b, 0);
        const regAccuracy = regRecent.length >= 40 ? regCorrect / regRecent.length : 1;

        if (regAccuracy < 0.75 && unlockedChars.length > 2) {
            const char = unlockedChars[unlockedChars.length - 1];
            this.sm.updateProgress({
                unlockedChars: unlockedChars.slice(0, -1),
                history: [] // Reset history on regression
            });
            return { status: 'regressed', char };
        }

        return { status: 'same' };
    }

    lockLast() {
        const { unlockedChars } = this.sm.state.progress;
        if (unlockedChars.length <= 2) return null;

        const removed = unlockedChars[unlockedChars.length - 1];
        const newList = unlockedChars.slice(0, -1);

        this.sm.updateProgress({
            unlockedChars: newList,
            currentKochIndex: newList.length,
            // Clear history on regression to allow for a fresh start at the lower level
            history: []
        });

        return removed;
    }

    unlockNext() {
        const next = this.getNextCharacter();
        if (next) {
            const { unlockedChars } = this.sm.state.progress;
            this.sm.updateProgress({
                unlockedChars: [...unlockedChars, next],
                currentKochIndex: unlockedChars.length + 1,
                // Reset history so they have to master the new character in the mix
                history: []
            });
            return next;
        }
        return null;
    }

    getEffectiveSettings(settings) {
        const level = this.sm.state.progress.unlockedChars.length - 1;
        const effectiveWpm = settings.wpm + Math.floor(level / 5);
        const isBlindOps = level >= 15;
        const lightFlashOn = isBlindOps ? false : settings.lightFlashOn;

        return {
            ...settings,
            wpm: effectiveWpm,
            lightFlashOn,
            isBlindOps,
            speedBoost: Math.floor(level / 5)
        };
    }
}

export const BLIND_OPS_LEVEL = 15;
export const SPEED_RAMP_STEP = 5;

export const trainingEngine = (sm) => new TrainingEngine(sm);
