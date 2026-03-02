import { morseEngine, MORSE_MAP } from '../engine/engine.js';

export class DrillController {
    constructor(trainingEngine, stateManager) {
        this.training = trainingEngine;
        this.sm = stateManager;
        this.currentSession = [];
        this.currentIndex = 0;
        this.startTime = 0;
        this.isProcessing = false;
        this.sessionTimings = [];

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
        const effective = this.training.getEffectiveSettings(this.sm.state.settings);
        const { wpm, farnsworth, lightFlashOn } = effective;

        // Show hint during replay
        if (this.ui.hint) this.ui.hint.style.opacity = '1';

        // Connect lamp to audio signals
        morseEngine.onSignalStart = () => this.ui.visualizer.classList.add('playing');
        morseEngine.onSignalEnd = () => this.ui.visualizer.classList.remove('playing');

        await morseEngine.playCharacter(targetChar, wpm, farnsworth);

        morseEngine.onSignalStart = null;
        morseEngine.onSignalEnd = null;

        // Hide hint after replay
        if (this.ui.hint) this.ui.hint.style.opacity = '0';
    }

    start() {
        this.currentSession = this.training.generateSession(20);
        this.currentIndex = 0;
        this.sessionTimings = [];
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

        // Fetch effective settings (including auto-boosts and Blind Ops)
        const effective = this.training.getEffectiveSettings(this.sm.state.settings);
        const { wpm, farnsworth, lightFlashOn } = effective;

        // Play audio with conditional reactive TX lamp feedback
        morseEngine.onSignalStart = () => {
            if (lightFlashOn) this.ui.visualizer.classList.add('playing');
        };
        morseEngine.onSignalEnd = () => {
            this.ui.visualizer.classList.remove('playing');
        };

        await morseEngine.playCharacter(targetChar, wpm, farnsworth);

        morseEngine.onSignalStart = null;
        morseEngine.onSignalEnd = null;

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
            btn.className = 'btn-rugged-glass';
            btn.style.height = '180px';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';

            const span = document.createElement('span');
            span.textContent = char;
            span.style.fontFamily = "'Stardos Stencil', serif";
            span.style.fontSize = '7rem';
            span.style.fontWeight = '700';
            span.className = 'distressed-stencil';

            btn.appendChild(span);
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

        if (isCorrect) {
            this.sessionTimings.push(responseTime);
        }

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
            title.innerHTML = `<span class="modal-px-header" style="color: var(--accent-success);">LEVEL UP</span>`;
            const level = this.sm.state.progress.unlockedChars.length - 1;

            const tierHtml = level % 5 === 0 ? `
              <div style="margin-top: 20px; padding: 12px; background: rgba(255,170,51,0.1); border: 1px solid rgba(255,170,51,0.3); border-radius: 8px; text-align: left;">
                <div class="modal-px-label" style="color: var(--accent-primary); font-size: 0.7rem; letter-spacing: 1px;">AUTO-SPEED BOOST: ACTIVATED</div>
                <div style="font-size: 0.9rem; color: var(--text-primary); margin-top: 4px; font-weight: 500;">SYSTEM OPERATING AT +${Math.floor(level / 5)} WPM</div>
              </div>
            ` : level === 15 ? `
              <div style="margin-top: 20px; padding: 12px; background: rgba(255,170,51,0.1); border: 1px solid var(--accent-danger); border-radius: 8px; text-align: left;">
                <div class="modal-px-label" style="color: var(--accent-danger); font-size: 0.7rem; letter-spacing: 1px;">BLIND OPS: ENGAGED</div>
                <div style="font-size: 0.9rem; color: var(--text-primary); margin-top: 4px; font-weight: 500;">TX LAMP DISABLED — AURAL PATTERN ONLY</div>
              </div>
            ` : '';

            body.innerHTML = `
                <div style="font-size: 6rem; margin-bottom: 16px; font-weight: 800; color: #ffffff; text-shadow: 0 0 30px var(--accent-primary); font-family: 'Stardos Stencil', serif;" class="distressed-stencil">${evaluation.char}</div>
                <div style="margin-bottom: 16px;">
                    <div class="modal-px-label" style="color: var(--accent-success);">NEW CHARACTER ADDED</div>
                    <p style="margin-top: 8px; font-size: 1.1rem;">Character <strong>${evaluation.char}</strong> is now cleared for operations.</p>
                    <div style="margin-top: 12px; font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px;">NEW LEVEL: <span style="color: var(--text-primary); font-weight: bold;">${level}</span></div>
                    ${tierHtml}
                </div>
            `;
        } else if (evaluation.status === 'regressed') {
            title.innerHTML = `<span class="modal-px-header" style="color: var(--accent-danger);">LEVEL LOCKED</span>`;
            body.innerHTML = `
                <div style="font-size: 5rem; margin-bottom: 16px; color: var(--accent-danger);">🔒</div>
                <div style="margin-bottom: 16px;">
                    <div class="modal-px-label" style="color: var(--accent-danger);">RETRAINING REQUIRED</div>
                    <p style="margin-top: 8px;">Accuracy dropped below 75%. <strong>${evaluation.char}</strong> has been locked to focus on mastery.</p>
                </div>
            `;
        } else {
            title.innerHTML = `<span class="modal-px-header">SESSION END</span>`;
            const { history, unlockedChars } = this.sm.state.progress;
            const recent = history.slice(-60);
            const acc = recent.length > 0 ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) : 0;
            const effective = this.training.getEffectiveSettings(this.sm.state.settings);
            const level = unlockedChars.length - 1;
            const evalProgress = history.length;

            const calculateMedian = (arr) => {
                if (!arr || arr.length === 0) return 0;
                const sorted = [...arr].sort((a, b) => a - b);
                const mid = Math.floor(sorted.length / 2);
                return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            };
            const sessionMedian = (calculateMedian(this.sessionTimings) / 1000).toFixed(2);

            const boostHtml = effective.speedBoost > 0 ? `
              <div style="font-size: 0.8rem; color: var(--accent-primary); margin-top: 2px;">+${effective.speedBoost} WPM BOOST ACTIVE</div>
            ` : '';

            body.innerHTML = `
              <div style="margin-bottom: 20px; width: 100%; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div class="glass" style="padding: 10px; background: rgba(0,0,0,0.2); border-radius: 12px;">
                    <div class="modal-px-label" style="font-size: 0.7rem;">CURRENT LEVEL</div>
                    <div class="modal-px-value" style="font-size: 1.6rem; color: var(--text-primary); margin-top: 4px;">LVL ${level}</div>
                </div>
                <div class="glass" style="padding: 10px; background: rgba(0,0,0,0.2); border-radius: 12px;">
                    <div class="modal-px-label" style="font-size: 0.7rem;">SESSION SPD</div>
                    <div class="modal-px-value" style="font-size: 1.6rem; color: var(--accent-primary); margin-top: 4px;">${sessionMedian}s</div>
                </div>
              </div>

              <div style="margin-bottom: 20px; padding: 16px; background: rgba(255,170,51,0.03); border-radius: 16px; border: 1px solid rgba(255,170,51,0.1);">
                <div class="modal-px-label">OPERATIONAL ACCURACY</div>
                <div class="modal-px-value" style="font-size: 3rem; color: ${acc >= 96 ? 'var(--accent-success)' : acc < 75 ? 'var(--accent-danger)' : 'var(--accent-warning)'}; margin-top: 4px;">${acc}%</div>
                <div class="modal-px-label" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; opacity: 0.6; font-weight: 400;">TARGET: 96% TO ADVANCE</div>
                ${boostHtml}
              </div>

              <div style="display: flex; justify-content: space-around; width: 100%; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 16px;">
                <div>
                  <div class="modal-px-label" style="font-size: 0.65rem;">EVALUATION</div>
                  <div class="modal-px-value" style="font-size: 1.5rem; color: var(--text-primary); margin-top: 4px;">${evalProgress}/60</div>
                </div>
                <div style="width: 1px; background: rgba(255,255,255,0.1); height: 30px;"></div>
                <div>
                  <div class="modal-px-label" style="font-size: 0.65rem;">STREAK</div>
                  <div class="modal-px-value" style="font-size: 1.5rem; color: var(--accent-primary); margin-top: 4px;">${this.sm.state.progress.streak}d</div>
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
