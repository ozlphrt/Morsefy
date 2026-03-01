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
    this.state = saved || INITIAL_STATE;

    // Migration for existing users: ensure new properties exist
    if (this.state.progress && !this.state.progress.history) {
      this.state.progress.history = [];
    }
    if (this.state.settings && this.state.settings.lightFlashOn === undefined) {
      this.state.settings.lightFlashOn = true;
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
      masteryTier: 'None',
      lastSeen: 0
    };

    stats.attempts++;
    if (isCorrect) stats.correct++;
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
