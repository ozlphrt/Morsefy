import { KOCH_ORDER } from '../training/training.js';
import { MORSE_MAP } from '../engine/engine.js';

export function renderProgressDashboard(state) {
    const grid = document.getElementById('mastery-grid');
    if (!grid) return;

    grid.innerHTML = '';

    // Total characters to show: all in KOCH_ORDER
    KOCH_ORDER.split('').forEach(char => {
        const stats = state.stats[char];
        const item = document.createElement('div');
        item.className = 'glass';
        item.style.height = '75px';
        item.style.display = 'flex';
        item.style.flexDirection = 'column';
        item.style.alignItems = 'center';
        item.style.justifyContent = 'center';
        item.style.position = 'relative';
        item.style.fontSize = '1.8rem';
        item.style.fontWeight = '800';
        item.style.cursor = 'pointer';

        const isUnlocked = state.progress.unlockedChars.includes(char);
        item.style.opacity = isUnlocked ? '1' : '0.2';

        if (isUnlocked) {
            const accuracy = stats ? (stats.correct / stats.attempts) : 0;

            // Mastery Ring
            const color = getMasteryColor(accuracy, stats?.attempts);
            item.style.border = `3px solid ${color}`;
            item.style.boxShadow = `0 0 15px ${color}44, inset 0 0 10px ${color}22`;

            item.onclick = () => showStats(char, stats, color);
        }

        item.textContent = char;
        grid.appendChild(item);
    });
}

function showStats(char, stats, color) {
    const modal = document.getElementById('modal-char-stats');
    const display = document.getElementById('stats-char-display');
    const morse = document.getElementById('stats-char-morse');
    const accEl = document.getElementById('stats-accuracy');
    const attEl = document.getElementById('stats-attempts');
    const spdEl = document.getElementById('stats-speed');
    const mastEl = document.getElementById('stats-mastery');
    const closeBtn = document.getElementById('modal-btn-stats-close');

    if (!modal) return;

    display.textContent = char;
    display.style.textShadow = `0 0 30px ${color}, 0 0 10px #ffffff`;
    morse.textContent = MORSE_MAP[char.toUpperCase()] || '';

    const accuracy = stats ? Math.round((stats.correct / stats.attempts) * 100) : 0;
    accEl.textContent = `${accuracy}%`;
    accEl.style.color = color;

    attEl.textContent = stats ? stats.attempts : 0;

    const avgSpeed = stats && stats.attempts > 0 ? (stats.totalTime / stats.attempts / 1000).toFixed(2) : '0.00';
    spdEl.textContent = `${avgSpeed}s`;

    // Mastery Name based on color/logic
    let masteryName = 'None';
    if (color === '#22c55e') masteryName = 'Operator';
    else if (color === '#15803d') masteryName = 'Expert';
    else if (color === '#facc15') masteryName = 'Advanced';
    else if (color === '#ea580c') masteryName = 'Intermediate';
    else if (color === '#ef4444') masteryName = 'Learner';
    else if (color === '#7f1d1d') masteryName = 'Novice';
    else masteryName = 'Practicing';

    mastEl.textContent = masteryName;
    mastEl.style.color = color;

    modal.classList.add('active');
    closeBtn.onclick = () => modal.classList.remove('active');
}
function getMasteryColor(accuracy, attempts) {
    if (!attempts || attempts < 10) return 'rgba(255,255,255,0.1)';

    // --- High Mastery (Green Tints) ---
    if (accuracy >= 0.96 && attempts >= 100) return '#22c55e'; // Bright Green (Operator)
    if (accuracy >= 0.93 && attempts >= 60) return '#15803d';  // Strong Green (Expert)

    // --- Medium Mastery (Yellow/Orange Tints) ---
    if (accuracy >= 0.91 && attempts >= 40) return '#facc15'; // Sunflower Yellow (Advanced)
    if (accuracy >= 0.88 && attempts >= 30) return '#ea580c'; // Vibrant Orange (Intermediate)

    // --- Low Mastery (Red Tints) ---
    if (accuracy >= 0.85 && attempts >= 20) return '#ef4444'; // Radiant Red (Learner)
    if (accuracy >= 0.75 && attempts >= 10) return '#7f1d1d'; // Deep Maroon (Novice)

    return 'var(--text-muted)';
}
