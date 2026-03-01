import { morseEngine, MORSE_MAP } from '../engine/engine.js';

export class DrillController {
    constructor(trainingEngine, stateManager) {
        this.training = trainingEngine;
        this.sm = stateManager;
        this.currentSession = [];
        this.currentIndex = 0;
        this.startTime = 0;
        this.isProcessing = false;

        this.ui = {
            choices: document.getElementById('drill-choices'),
            progress: document.getElementById('drill-progress'),
            accuracy: document.getElementById('drill-accuracy'),
            visualizer: document.getElementById('audio-visualizer'),
            hint: document.getElementById('drill-hint'),
        };

        this.initEvents();
    }

    initEvents() {
        // Hint logic: Hold to peek
        const showHint = () => {
            if (this.ui.hint) this.ui.hint.style.opacity = '1';
        };
        const hideHint = () => {
            if (this.ui.hint) this.ui.hint.style.opacity = '0';
        };

        this.ui.visualizer?.addEventListener('mousedown', showHint);
        this.ui.visualizer?.addEventListener('mouseup', hideHint);
        this.ui.visualizer?.addEventListener('mouseleave', hideHint);
        this.ui.visualizer?.addEventListener('touchstart', (e) => {
            e.preventDefault();
            showHint();
        });
        this.ui.visualizer?.addEventListener('touchend', hideHint);

        // Click to replay + show hint
        this.ui.visualizer?.addEventListener('click', () => this.replay());
    }

    async replay() {
        if (this.isProcessing) return;
        const targetChar = this.currentSession[this.currentIndex];
        const { wpm, farnsworth } = this.sm.state.settings;

        // Show hint during replay
        if (this.ui.hint) this.ui.hint.style.opacity = '1';

        this.ui.visualizer.classList.add('playing');
        await morseEngine.playCharacter(targetChar, wpm, farnsworth);
        this.ui.visualizer.classList.remove('playing');

        // Hide hint after replay
        if (this.ui.hint) this.ui.hint.style.opacity = '0';
    }

    start() {
        this.currentSession = this.training.generateSession(20);
        this.currentIndex = 0;
        this.updateStats();
        this.nextQuestion();
    }

    async nextQuestion() {
        if (this.currentIndex >= this.currentSession.length) {
            this.finishSession();
            return;
        }

        this.isProcessing = true;

        if (this.currentIndex === 0) {
            await morseEngine.warmUp();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const targetChar = this.currentSession[this.currentIndex];

        // Update hint text
        if (this.ui.hint) {
            this.ui.hint.textContent = MORSE_MAP[targetChar.toUpperCase()] || '...';
        }

        this.renderChoices(targetChar);

        // Play audio with flash feedback if enabled
        const { wpm, farnsworth, lightFlashOn } = this.sm.state.settings;

        if (lightFlashOn) {
            morseEngine.onSignalStart = () => this.ui.visualizer.classList.add('flash');
            morseEngine.onSignalEnd = () => this.ui.visualizer.classList.remove('flash');
        } else {
            morseEngine.onSignalStart = null;
            morseEngine.onSignalEnd = null;
        }

        this.ui.visualizer.classList.add('playing');
        await morseEngine.playCharacter(targetChar, wpm, farnsworth);
        this.ui.visualizer.classList.remove('playing');

        this.startTime = Date.now();
        this.isProcessing = false;
    }

    renderChoices(target) {
        this.ui.choices.innerHTML = '';
        const { unlockedChars } = this.sm.state.progress;
        let fallback = unlockedChars.find(c => c !== target);
        const choices = [target, fallback].sort(() => Math.random() - 0.5);

        choices.forEach(char => {
            const btn = document.createElement('button');
            btn.textContent = char;
            btn.style.fontSize = '2.5rem';
            btn.style.height = '120px';
            btn.className = 'glass';
            btn.onclick = () => this.handleAnswer(char);
            this.ui.choices.appendChild(btn);
        });
    }

    handleAnswer(selected) {
        if (this.isProcessing) return;

        const target = this.currentSession[this.currentIndex];
        const isCorrect = selected === target;
        const responseTime = Date.now() - this.startTime;

        this.sm.updateCharStats(target, isCorrect, responseTime);

        const btns = this.ui.choices.querySelectorAll('button');
        btns.forEach(btn => {
            if (btn.textContent === target) btn.classList.add('btn-lit-success');
            else if (btn.textContent === selected && !isCorrect) btn.classList.add('btn-lit-danger');
            btn.disabled = true;
        });

        setTimeout(() => {
            this.currentIndex++;
            this.updateStats();
            this.nextQuestion();
        }, 800);
    }

    updateStats() {
        this.ui.progress.textContent = `${this.currentIndex + 1}/${this.currentSession.length}`;

        const stats = Object.values(this.sm.state.stats);
        if (stats.length > 0) {
            const total = stats.reduce((a, b) => a + b.attempts, 0);
            const correct = stats.reduce((a, b) => a + b.correct, 0);
            const acc = Math.round((correct / total) * 100);
            this.ui.accuracy.textContent = `${acc}%`;
        }
    }

    finishSession() {
        const result = this.training.checkUnlockProgress();

        const today = new Date().toDateString();
        const last = this.sm.state.progress.lastSessionDate;
        let newStreak = this.sm.state.progress.streak;

        if (last !== today) {
            newStreak = (last === new Date(Date.now() - 86400000).toDateString()) ? newStreak + 1 : 1;
        }

        this.sm.updateProgress({
            xp: this.sm.state.progress.xp + 50,
            streak: newStreak,
            lastSessionDate: today
        });

        this.showCompletionModal(result);
    }

    showCompletionModal(evaluation) {
        // Reset engine callbacks on finish
        morseEngine.onSignalStart = null;
        morseEngine.onSignalEnd = null;

        const modal = document.getElementById('modal-container');
        const body = document.getElementById('modal-body');
        const title = document.getElementById('modal-title');
        const closeBtn = document.getElementById('modal-btn-close');

        if (evaluation.status === 'unlocked') {
            title.textContent = "New Level Unlocked!";
            body.innerHTML = `
                <div style="font-size: 6rem; margin-bottom: 20px; font-weight: 800; color: #ffffff; text-shadow: 0 0 30px var(--accent-primary);">${evaluation.char}</div>
                <div style="margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: var(--text-muted);">NEW CHARACTER ADDED</div>
                    <p>You mastered the current set! Training for <strong>${evaluation.char}</strong> starts now.</p>
                </div>
            `;
        } else if (evaluation.status === 'regressed') {
            title.textContent = "Level Locked";
            body.innerHTML = `
                <div style="font-size: 4rem; margin-bottom: 20px; color: var(--accent-danger);">🔒</div>
                <div style="margin-bottom: 20px;">
                    <div style="font-size: 0.9rem; color: var(--accent-danger);">BACK TO BASICS</div>
                    <p>Accuracy dropped below 75%. Character <strong>${evaluation.char}</strong> has been locked to help you focus on mastery of previous characters.</p>
                </div>
            `;
        } else {
            title.textContent = "Session Complete!";
            const { history } = this.sm.state.progress;
            const recent = history.slice(-60);
            const acc = recent.length > 0 ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) : 0;

            body.innerHTML = `
              <div style="margin-bottom: 20px;">
                <div style="font-size: 0.9rem; color: var(--text-muted);">ROLLING ACCURACY (LAST 60)</div>
                <div style="font-size: 2.5rem; font-weight: bold; color: ${acc >= 96 ? 'var(--accent-success)' : acc < 75 ? 'var(--accent-danger)' : 'var(--accent-warning)'};">${acc}%</div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 4px;">Target: 96% to Level Up | < 75% to Regress</div>
              </div>
              <div style="display: flex; justify-content: space-around; width: 100%;">
                <div>
                  <div style="font-size: 0.8rem; color: var(--text-muted);">XP</div>
                  <div style="font-size: 1.1rem; font-weight: bold;">+50</div>
                </div>
                <div>
                  <div style="font-size: 0.8rem; color: var(--text-muted);">STREAK</div>
                  <div style="font-size: 1.1rem; font-weight: bold;">${this.sm.state.progress.streak}d</div>
                </div>
              </div>
            `;
        }

        modal.classList.add('active');
        closeBtn.onclick = () => {
            modal.classList.remove('active');
            this.start();
        };
    }
}
