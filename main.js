import './style.css';
import { stateManager } from './src/state/state.js';
import { trainingEngine } from './src/training/training.js';
import { DrillController } from './src/ui/DrillController.js';
import { renderProgressDashboard } from './src/ui/ProgressDashboard.js';

const training = trainingEngine(stateManager);
const drillController = new DrillController(training, stateManager);

// --- Screen Management ---
const screens = {
    home: document.getElementById('screen-home'),
    drill: document.getElementById('screen-drill'),
    progress: document.getElementById('screen-progress'),
    settings: document.getElementById('screen-settings'),
};

const navItems = document.querySelectorAll('.nav-item');

function showScreen(screenId) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    navItems.forEach(n => n.classList.remove('active'));

    if (screens[screenId]) {
        screens[screenId].classList.add('active');
        const activeNav = document.querySelector(`.nav-item[data-screen="${screenId}"]`);
        if (activeNav) activeNav.classList.add('active');
    }
}

// --- Event Listeners ---
navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const screenId = item.getAttribute('data-screen');
        showScreen(screenId);
    });
});

document.getElementById('btn-start-drill')?.addEventListener('click', () => {
    showScreen('drill');
    drillController.start();
});

document.getElementById('btn-exit-drill')?.addEventListener('click', () => {
    showScreen('home');
});

// --- UI Updates ---
function updateUI(state) {
    const streakEl = document.getElementById('home-streak');
    const xpEl = document.getElementById('home-xp');
    const progressLine = document.getElementById('home-progress-bar');

    if (streakEl) streakEl.textContent = `${state.progress.streak} SEQ`;
    if (xpEl) xpEl.textContent = `${state.progress.xp} XP`;
    if (progressLine) {
        // Basic calculation for progress bar
        const totalChars = 43; // A-Z, 0-9, + common punctuation
        const unlockedCount = state.progress.unlockedChars.length;
        const percent = (unlockedCount / totalChars) * 100;
        progressLine.style.width = `${percent}%`;

        const textEl = document.getElementById('home-progress-text');
        if (textEl) {
            const history = state.progress.history || [];
            const count = history.length;

            if (count < 60) {
                textEl.textContent = `Level ${unlockedCount - 1} • Warm up: ${60 - count} attempts until evaluation`;
                textEl.style.color = 'var(--text-muted)';
            } else {
                const recent = history.slice(-60);
                const acc = Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100);
                textEl.textContent = `Level ${unlockedCount - 1} • Mastery: ${acc}% (Need 96% to advance)`;
                textEl.style.color = acc >= 96 ? 'var(--accent-success)' : acc < 75 ? 'var(--accent-danger)' : 'var(--text-muted)';
            }
        }
    }

    // Update settings inputs
    const wpmInput = document.getElementById('setting-wpm');
    const farnsworthInput = document.getElementById('setting-farnsworth');
    const flashInput = document.getElementById('setting-light-flash');

    if (wpmInput) wpmInput.value = state.settings.wpm;
    if (farnsworthInput) farnsworthInput.value = state.settings.farnsworth;
    if (flashInput) flashInput.checked = state.settings.lightFlashOn;

    // Update Progress Dashboard
    renderProgressDashboard(state);
}

// --- Initialization ---
stateManager.subscribe(updateUI);
updateUI(stateManager.state);

// Settings listeners
document.getElementById('setting-wpm')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('val-wpm').textContent = val;
    stateManager.updateSettings({ wpm: val });
});

document.getElementById('setting-farnsworth')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('val-farnsworth').textContent = val;
    stateManager.updateSettings({ farnsworth: val });
});

document.getElementById('setting-light-flash')?.addEventListener('change', (e) => {
    stateManager.updateSettings({ lightFlashOn: e.target.checked });
});

document.getElementById('btn-reset-progress')?.addEventListener('click', () => {
    document.getElementById('modal-reset-container').classList.add('active');
});

document.getElementById('modal-btn-reset-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-reset-container').classList.remove('active');
});

document.getElementById('modal-btn-reset-confirm')?.addEventListener('click', () => {
    stateManager.resetState();
    window.location.reload();
});

document.getElementById('btn-restart-level')?.addEventListener('click', () => {
    document.getElementById('modal-restart-container').classList.add('active');
});

document.getElementById('modal-btn-restart-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-restart-container').classList.remove('active');
});

document.getElementById('modal-btn-restart-confirm')?.addEventListener('click', () => {
    stateManager.restartLevel();
    window.location.reload();
});

console.log('Morsefy Initialized');
