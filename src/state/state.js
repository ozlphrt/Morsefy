/**
 * Simple State Management for Morsefy
 */

export const INITIAL_STATE = {
  settings: {
    wpm: 20,
    farnsworth: 10,
    soundOn: true,
    vibrationOn: true,
    lightFlashOn: true
  },
  progress: {
    unlockedChars: ['K', 'M'], // Koch starts with K and M
    currentKochIndex: 2,
    streak: 0,
    xp: 0,
    level: 1,
    lastSessionDate: null,
    history: [] // Last 50 attempts [1, 0, 1...] for adaptive progression
  },
  stats: {} // Map of char -> { attempts, correct, totalTime, masteryTier, lastSeen }
};

class StateManager {
  constructor() {
    const saved = JSON.parse(localStorage.getItem('morsefy_state'));

    // Start with a clean copy of the current schema
    this.state = JSON.parse(JSON.stringify(INITIAL_STATE));

    // Safely merge existing user data over the default schema
    if (saved) {
      if (saved.settings) this.state.settings = { ...this.state.settings, ...saved.settings };
      if (saved.progress) this.state.progress = { ...this.state.progress, ...saved.progress };
      if (saved.stats) this.state.stats = { ...this.state.stats, ...saved.stats };

      // Safety net for critical arrays that might be missing in older versions
      if (!this.state.progress.history) this.state.progress.history = [];
      if (!this.state.progress.unlockedChars) this.state.progress.unlockedChars = [...INITIAL_STATE.progress.unlockedChars];
    }

    this.listeners = [];
  }

  save() {
    localStorage.setItem('morsefy_state', JSON.stringify(this.state));
    this.notify();
  }

  updateProgress(patch) {
    this.state.progress = { ...this.state.progress, ...patch };
    this.save();
  }

  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
  }

  updateCharStats(char, isCorrect, responseTime) {
    const stats = this.state.stats[char] || {
      attempts: 0,
      correct: 0,
      totalTime: 0,
      recentTimings: [],
      masteryTier: 'None',
      lastSeen: 0
    };

    if (!stats.recentTimings) stats.recentTimings = [];

    stats.attempts++;
    if (isCorrect) {
      stats.correct++;
      // Only track timings for correct answers to represent actual skill speed
      stats.recentTimings.push(responseTime);
      if (stats.recentTimings.length > 50) stats.recentTimings.shift();
    }
    stats.totalTime += responseTime;
    stats.lastSeen = Date.now();

    this.state.stats[char] = stats;

    // Update global history for adaptive progression
    this.state.progress.history.push(isCorrect ? 1 : 0);
    if (this.state.progress.history.length > 100) {
      this.state.progress.history.shift();
    }

    this.save();
  }

  resetState() {
    this.state = JSON.parse(JSON.stringify(INITIAL_STATE));
    this.save();
  }

  restartLevel() {
    this.state.progress.history = [];
    this.save();
  }

  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  notify() {
    this.listeners.forEach(l => l(this.state));
  }
}

export const stateManager = new StateManager();
