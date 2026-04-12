import { App, Modal, Setting, Notice } from "obsidian";
import { VaultManager } from "./vaultManager.ts";

export class SetupModal extends Modal {
    private passInputEl: HTMLInputElement | null = null;
    private pass1Bytes: Uint8Array | null = null;
    private resolved = false;
    private progressCircle: SVGCircleElement | null = null;
    private progressText: HTMLElement | null = null;
    private progressContainer: HTMLElement | null = null;
    private inputRows: HTMLElement[] = [];
    private lockoutEl: HTMLElement | null = null;
    private lockoutTimerText: HTMLElement | null = null;
    private lockoutInterval: number | null = null;
    private realProgress = 0;
    private visualProgress = 0;
    private isCleaningUp = false;
    private recoveryManifestBytes: Uint8Array | null = null;
    private mSetting: Setting | null = null;
    private tSetting: Setting | null = null;
    private mSlider: any = null;
    private tSlider: any = null;

    constructor(
        app: App, 
        private vaultManager: VaultManager, 
        private isFirstTime: boolean,
        private onResolved?: () => void,
        private onRejected?: (err: Error) => void
    ) {
        super(app);
    }

    private argonM = 512;
    private argonT = 4;
    private estimationEl: HTMLElement | null = null;
    private testBtn: HTMLButtonElement | null = null;

    onOpen() {
        const { contentEl } = this;
        contentEl.classList.add("uwu-setup-modal");

        // 1. Build ALL UI elements first
        this.buildUI();

        // 2. Check for lockout and decide what to show
        const remaining = this.vaultManager.getLockoutRemaining();
        if (remaining > 0) {
            this.showLockout(remaining);
            return;
        }

        this.renderForm();
    }

    private buildUI() {
        // --- Lockout UI ---
        this.lockoutEl = document.createElement("div");
        this.lockoutEl.addClass("uwu-lockout-overlay");
        
        const clockSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        clockSvg.setAttribute("viewBox", "0 0 24 24");
        clockSvg.classList.add("uwu-clock-icon");
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "10");
        circle.setAttribute("fill", "none"); circle.setAttribute("stroke", "currentColor"); circle.setAttribute("stroke-width", "2");
        const hour = document.createElementNS("http://www.w3.org/2000/svg", "line");
        hour.setAttribute("x1", "12"); hour.setAttribute("y1", "12"); hour.setAttribute("x2", "12"); hour.setAttribute("y2", "7");
        hour.classList.add("uwu-clock-hand", "uwu-clock-hand-hour");
        const min = document.createElementNS("http://www.w3.org/2000/svg", "line");
        min.setAttribute("x1", "12"); min.setAttribute("y1", "12"); min.setAttribute("x2", "16"); min.setAttribute("y2", "12");
        min.classList.add("uwu-clock-hand", "uwu-clock-hand-min");
        clockSvg.appendChild(circle); clockSvg.appendChild(hour); clockSvg.appendChild(min);
        this.lockoutEl.appendChild(clockSvg);

        this.lockoutEl.createEl("h3", { text: "Too many attempts", cls: "uwu-lockout-title" });
        this.lockoutTimerText = this.lockoutEl.createEl("div", { text: "00s", cls: "uwu-lockout-timer" });
        this.lockoutEl.createEl("div", { text: "（︶^︶）", cls: "uwu-lockout-kaomoji" });

        // --- Progress UI ---
        this.progressContainer = document.createElement("div");
        this.progressContainer.addClass("uwu-progress-container");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.classList.add("uwu-progress-svg");
        
        const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        bg.setAttribute("cx", "50"); bg.setAttribute("cy", "50"); bg.setAttribute("r", "40");
        bg.classList.add("uwu-progress-bg");
        
        this.progressCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        this.progressCircle.setAttribute("cx", "50"); this.progressCircle.setAttribute("cy", "50"); this.progressCircle.setAttribute("r", "40");
        this.progressCircle.classList.add("uwu-progress-bar");
        
        svg.appendChild(bg); svg.appendChild(this.progressCircle);
        this.progressContainer.appendChild(svg);
        this.progressText = this.progressContainer.createDiv({ cls: "uwu-progress-text", text: "Protecting..." });
    }

    private renderForm() {
        const { contentEl } = this;
        contentEl.empty();
        const h2 = contentEl.createEl("h2", { text: this.isFirstTime ? "Initialize UWU-Crypt" : "Unlock Vault" });
        this.inputRows.push(h2);
        
        const description = contentEl.createDiv({ cls: "uwu-setup-description" });
        this.inputRows.push(description);
        if (this.isFirstTime) {
            description.createEl("p", { 
                text: "Setting up a new encryption vault. Keep your passwords safe! Losing them means losing your data permanently. (✿◡‿◡)"
            });
        }

        const createRow = (name: string, desc: string, placeholder: string, onChange: (v: string) => void, onInit?: (text: any) => void) => {
            const row = new Setting(contentEl)
                .setName(name)
                .setDesc(desc)
                .addText((text) => {
                    text.setPlaceholder(placeholder)
                        .onChange((v) => {
                            onChange(v);
                            this.updateEstimation(v);
                        });
                    text.inputEl.type = "password";
                    if (onInit) onInit(text);
                    text.inputEl.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") {
                            this.contentEl.querySelector(".mod-cta")?.dispatchEvent(new MouseEvent("click"));
                        }
                    });
                });
            this.inputRows.push(row.settingEl);
            return row;
        };

        createRow("Master Vault Password", "Enter your master key phrase.", "...", (v) => {
            if (this.pass1Bytes) { 
                this.pass1Bytes.fill(0); 
                this.pass1Bytes = null;
            }
            this.updateEstimation(v);
        }, (text) => {
            this.passInputEl = text.inputEl;
        });

        if (this.isFirstTime) {
            const argonHeader = contentEl.createEl("h3", { text: "Argon2id Parameters", attr: { style: "margin-top: 20px;" } });
            this.inputRows.push(argonHeader);
            
            this.mSetting = new Setting(contentEl)
                .setName("Memory (M)")
                .setDesc(`${this.argonM} MB`)
                .addSlider(slider => {
                    this.mSlider = slider;
                    slider.setLimits(32, 1024, 32)
                        .setValue(this.argonM)
                        .onChange((v) => {
                            this.argonM = v;
                            this.mSetting?.setDesc(`${v} MB`);
                            this.updateEstimation(this.passInputEl?.value || "");
                            if (this.testBtn) this.testBtn.textContent = 'Run Dry-run';
                        });
                    // Real-time update
                    slider.sliderEl.addEventListener("input", () => {
                        const v = parseInt(slider.sliderEl.value);
                        this.argonM = v;
                        this.mSetting?.setDesc(`${v} MB`);
                        this.updateEstimation(this.passInputEl?.value || "");
                    });
                });
            this.inputRows.push(this.mSetting.settingEl);

            this.tSetting = new Setting(contentEl)
                .setName("Iterations (T)")
                .setDesc(`${this.argonT}`)
                .addSlider(slider => {
                    this.tSlider = slider;
                    slider.setLimits(2, 10, 1)
                        .setValue(this.argonT)
                        .onChange((v) => {
                            this.argonT = v;
                            this.tSetting?.setDesc(`${v}`);
                            this.updateEstimation(this.passInputEl?.value || "");
                            if (this.testBtn) this.testBtn.textContent = 'Run Dry-run';
                        });
                    // Real-time update
                    slider.sliderEl.addEventListener("input", () => {
                        const v = parseInt(slider.sliderEl.value);
                        this.argonT = v;
                        this.tSetting?.setDesc(`${v}`);
                        this.updateEstimation(this.passInputEl?.value || "");
                    });
                });
            this.inputRows.push(this.tSetting.settingEl);

            const testRow = new Setting(contentEl)
                .setName("Performance Test")
                .setDesc("Measure how long verification takes on this device.")
                .addButton(btn => {
                    this.testBtn = btn.buttonEl;
                    btn.setButtonText("Run Dry-run")
                        .onClick(async () => {
                            btn.setDisabled(true);
                            btn.setButtonText("Testing...");
                            try {
                                const time = await this.vaultManager.testPerformance(this.argonM * 1024, this.argonT, (p) => {
                                    this.realProgress = p;
                                });
                                new Notice(`( •_•)>⌐■-■ Benchmark: ${time.toFixed(0)}ms`);
                                btn.setButtonText(`Result: ${time.toFixed(0)}ms`);
                            } catch (e) {
                                btn.setButtonText("Error");
                            } finally {
                                btn.setDisabled(false);
                            }
                        });
                });
            this.inputRows.push(testRow.settingEl);

            this.estimationEl = contentEl.createDiv({ cls: "uwu-estimation-container", attr: { style: "margin: 20px 0; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 5px;" } });
            this.inputRows.push(this.estimationEl);
            this.updateEstimation(this.passInputEl?.value || "");

            // --- BYOM SECTION ---
            const recoveryHeader = contentEl.createEl("h3", { text: "BYOM (Bring Your Own Manifest)", attr: { style: "margin-top: 30px; border-top: 1px solid var(--background-modifier-border); padding-top: 20px;" } });
            this.inputRows.push(recoveryHeader);

            const recoveryDesc = contentEl.createDiv({ 
                text: "Use an existing manifest as a template for this vault. This will preserve your salt and hash check.",
                cls: "setting-item-description",
                attr: { style: "margin-bottom: 10px;" }
            });
            this.inputRows.push(recoveryDesc);

            const recoverySetting = new Setting(contentEl)
                .setName("Paste Manifest (Base64)")
                .setDesc("")
                .addTextArea(text => {
                    text.setPlaceholder("e.g. mP8AAQAAAAT...")
                        .onChange(async (v) => {
                            v = v.trim();
                            if (!v) {
                                recoverySetting.setDesc("");
                                this.recoveryManifestBytes = null;
                                return;
                            }
                            try {
                                const bytes = this.vaultManager.base64ToUint8(v);
                                if (this.vaultManager.isManifestHealthy(bytes)) {
                                    this.recoveryManifestBytes = bytes;
                                    recoverySetting.setDesc("Manifest OK (⌐■_■)");
                                    recoverySetting.descEl.style.color = "var(--text-success)";

                                    // Parse Argon2 params via WASM — no manual byte parsing
                                    const { get_manifest_params } = await import('../pkg/uwu_crypt.js');
                                    const params = get_manifest_params(bytes) as { m: number, t: number };
                                    if (params && typeof params.m === 'number' && typeof params.t === 'number') {
                                        this.argonM = params.m;
                                        this.argonT = params.t;

                                        // Update Sliders UI
                                        if (this.mSlider) {
                                            this.mSlider.setValue(params.m);
                                            this.mSetting?.setDesc(`${params.m} MB`);
                                        }
                                        if (this.tSlider) {
                                            this.tSlider.setValue(params.t);
                                            this.tSetting?.setDesc(`${params.t}`);
                                        }
                                        this.updateEstimation(this.passInputEl?.value || "");
                                    }
                                } else {
                                    throw new Error("Invalid structure");
                                }
                            } catch (e) {
                                if (this.recoveryManifestBytes) {
                                    this.recoveryManifestBytes.fill(0);
                                    this.recoveryManifestBytes = null;
                                }
                                recoverySetting.setDesc("Error (⊙ˍ⊙)");
                                recoverySetting.descEl.style.color = "var(--text-error)";
                            }
                        });
                    text.inputEl.rows = 3;
                    text.inputEl.style.width = "100%";
                });
            this.inputRows.push(recoverySetting.settingEl);
        }

        const actionRow = new Setting(contentEl);
        actionRow.addButton((btn) =>
            btn.setButtonText(this.isFirstTime ? "Initialize Vault" : "Unlock")
                .setCta()
                .onClick(async () => {
                    this.startProcessing();
                    let statusTimer: number | null = null;
                    let elapsed = 0;
                    statusTimer = window.setInterval(() => {
                        elapsed++;
                        if (this.progressText) {
                            this.progressText.textContent = this.isFirstTime
                                ? `Deriving keys... (${elapsed}s)`
                                : `Verifying... (${elapsed}s)`;
                        }
                    }, 1000);
                    try {
                        const rawValue = this.passInputEl?.value || "";
                        const passBytes = new TextEncoder().encode(rawValue);
                        this.pass1Bytes = new Uint8Array(passBytes);
                        
                        // Clear the input value from DOM as soon as possible
                        if (this.passInputEl) this.passInputEl.value = "";
                        this.realProgress = 0;
                        if (this.isFirstTime) {
                            if (this.recoveryManifestBytes) {
                                // RECOVERY FLOW
                                await this.vaultManager.unlockVault(this.pass1Bytes, (p) => {
                                    this.realProgress = p;
                                }, this.recoveryManifestBytes);
                            } else {
                                // NEW VAULT FLOW
                                await this.vaultManager.createVault(this.pass1Bytes, this.argonM * 1024, this.argonT, (p) => {
                                    this.realProgress = p;
                                });
                            }
                        } else {
                            await this.vaultManager.unlockVault(this.pass1Bytes, (p) => {
                                this.realProgress = p;
                            });
                        }
                        if (statusTimer) clearInterval(statusTimer);
                        
                        // Плавный переход к 100%
                        this.realProgress = 100;
                        this.resolved = true;
                
                        // Wait for visual animation to catch up (max 1s)
                        const startWait = Date.now();
                        while (this.visualProgress < 99.5 && (Date.now() - startWait) < 1000) {
                            await new Promise(r => requestAnimationFrame(r));
                        }
                        
                        if (this.onResolved) this.onResolved();
                        
                        // Premium fade-out
                        this.containerEl.addClass("uwu-modal-closing");
                        await new Promise(r => setTimeout(r, 300));
                        this.close();
                    } catch (err: any) {
                        if (statusTimer) clearInterval(statusTimer);
                        if (this.passInputEl) this.passInputEl.value = "";
                        if (this.pass1Bytes) { 
                            try { if (this.pass1Bytes.buffer.byteLength > 0) this.pass1Bytes.fill(0); } catch {}
                            this.pass1Bytes = null; 
                        }

                        const remaining = this.vaultManager.getLockoutRemaining();
                        if (remaining > 0) {
                            this.showLockout(remaining);
                        } else {
                            this.showError(err.message);
                        }
                    }
                })
        );
        this.inputRows.push(actionRow.settingEl);
    }

    private updateEstimation(combinedPass: string) {
        if (!this.estimationEl) return;
        this.estimationEl.empty();
        
        if (combinedPass.length === 0) {
            this.estimationEl.createEl("p", { text: "Enter password to see brute-force estimation.", attr: { style: "font-style: italic; opacity: 0.7;" } });
            return;
        }

        let charsetSize = 0;
        if (/[a-z]/.test(combinedPass)) charsetSize += 26;
        if (/[A-Z]/.test(combinedPass)) charsetSize += 26;
        if (/[0-9]/.test(combinedPass)) charsetSize += 10;
        if (/[^a-zA-Z0-9]/.test(combinedPass)) charsetSize += 32;

        const entropy = charsetSize > 0 ? combinedPass.length * Math.log2(charsetSize) : 0;
        const totalCombinations = Math.pow(2, entropy);
        
        const rtx5090Bandwidth = 1792 * 1024 * 1024 * 1024; 
        const totalRtxBandwidth = rtx5090Bandwidth * 1000;
        const frontierBandwidth = 120.3e15; 

        const memorySizeBytes = this.argonM * 1024 * 1024;
        const bytesPerAttempt = (memorySizeBytes * 2 * this.argonT) * 2; 

        const efficiency = 0.30;
        const thousandRtxRate = (totalRtxBandwidth / bytesPerAttempt) * efficiency;
        const frontierRate = (frontierBandwidth / bytesPerAttempt) * efficiency;

        const formatTime = (seconds: number) => {
            if (!isFinite(seconds) || seconds > 31536000 * 1e15) return "> 1 quadrillion years";
            if (seconds > 31536000 * 1e12) return `${Math.round(seconds / (31536000 * 1e12))} trillion years`;
            if (seconds > 31536000 * 1e9) return `${Math.round(seconds / (31536000 * 1e9))} billion years`;
            if (seconds > 31536000 * 1e6) return `${Math.round(seconds / (31536000 * 1e6))} million years`;
            if (seconds > 31536000) return `${Math.round(seconds / 31536000 * 10) / 10} years`;
            if (seconds > 86400) return `${Math.round(seconds / 86400)} days`;
            if (seconds > 3600) return `${Math.round(seconds / 3600)} hours`;
            if (seconds > 60) return `${Math.round(seconds / 60)} minutes`;
            return `${seconds.toFixed(2)} seconds`;
        };

        const rtxTime = formatTime(totalCombinations / thousandRtxRate);
        const frontierTime = formatTime(totalCombinations / frontierRate);

        this.estimationEl.createEl("strong", { text: "Scientific Brute-force Estimation (Bandwidth Limited):" });
        const list = this.estimationEl.createEl("ul", { attr: { style: "margin: 5px 0 0 20px; font-size: 0.9em;" } });
        list.createEl("li", { text: `1000x RTX 5090 (~1.8 PB/s): ${rtxTime}` });
        list.createEl("li", { text: `1x Frontier (~120 PB/s): ${frontierTime}` });
        
        const entropyColor = entropy < 64 ? "#ff4d4d" : entropy < 96 ? "#ffd633" : "#33ff77";
        this.estimationEl.createEl("div", { 
            text: `Entropy: ~${Math.round(entropy)} bits (Charset: ${charsetSize}, Space: 2^${Math.round(entropy)})`,
            attr: { style: `margin-top: 10px; font-size: 0.8em; color: ${entropyColor};` }
        });
    }

    private startProcessing() {
        if (this.estimationEl) this.estimationEl.style.display = 'none';
        this.inputRows.forEach(row => row.style.display = 'none');
        this.contentEl.appendChild(this.progressContainer!);
        this.progressContainer!.style.display = 'flex';
        
        // Ensure reset state
        this.realProgress = 0;
        if (this.progressText) this.progressText.textContent = this.isFirstTime ? "Deriving... 0%" : "Verifying... 0%";
        if (this.progressCircle) this.progressCircle.style.strokeDashoffset = "251.2";
        
        this.animateProgress();
    }

    private showError(msg: string) {
        new Notice(`(⊙ˍ⊙) Error: ${msg}`);
        this.inputRows.forEach(row => row.style.display = '');
        if (this.progressContainer) this.progressContainer.style.display = 'none';
        if (this.estimationEl) this.estimationEl.style.display = 'block';
        
        // Reset progress state for next attempt
        this.realProgress = 0;
        if (this.progressText) this.progressText.textContent = this.isFirstTime ? "Deriving... 0%" : "Verifying... 0%";
        if (this.progressCircle) {
           this.progressCircle.style.strokeDashoffset = "251.2";
        }
    }

    private showLockout(remainingMs: number): void {
        this.contentEl.empty();
        this.contentEl.appendChild(this.lockoutEl!);
        this.lockoutEl!.style.display = 'flex';

        const formatTime = (s: number) => {
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
        };

        if (this.lockoutTimerText) {
            this.lockoutTimerText.textContent = formatTime(Math.ceil(remainingMs / 1000));
        }

        if (this.lockoutInterval) clearInterval(this.lockoutInterval);
        this.lockoutInterval = window.setInterval(() => {
            const left = this.vaultManager.getLockoutRemaining();
            if (left <= 0) {
                if (this.lockoutInterval) clearInterval(this.lockoutInterval);
                this.lockoutInterval = null;
                this.vaultManager.notifyLockoutReady();
                this.onOpen(); 
            } else {
                if (this.lockoutTimerText) {
                    this.lockoutTimerText.textContent = formatTime(Math.ceil(left / 1000));
                }
            }
        }, 1000);
    }

    private animateProgress() {
        let currentProgress = 0;
        const target = 95; 
        const duration = 2000; // Slower estimation by default to let real milestones lead
        const startTime = Date.now();

        const frame = () => {
            if (!this.progressCircle) return;
            
            const elapsed = Date.now() - startTime;
            const estimated = Math.min(target, (elapsed / duration) * target);
            
            // If resolved, snap to 100. Otherwise follow high-water mark of estimated vs real.
            let actualTarget = this.resolved ? 100 : Math.max(estimated, this.realProgress);

            if (this.resolved) {
                currentProgress = 100;
            } else if (currentProgress < actualTarget) {
                const diff = actualTarget - currentProgress;
                const speed = diff > 20 ? 0.15 : 0.08;
                currentProgress += diff * speed;
            }
            
            this.visualProgress = currentProgress;
            this.updateCircle(currentProgress);

            if (currentProgress < 99.9 && !this.isCleaningUp) {
                requestAnimationFrame(frame);
            }
        };
        requestAnimationFrame(frame);
    }

    private updateCircle(percent: number) {
        if (!this.progressCircle) return;
        const radius = 40;
        const circumference = 2 * Math.PI * radius;
        const offset = circumference - (percent / 100) * circumference;
        this.progressCircle.style.strokeDashoffset = offset.toString();
        
        if (this.progressText) {
            this.progressText.textContent = this.isFirstTime ? `Deriving keys... ${Math.round(percent)}%` : `Verifying... ${Math.round(percent)}%`;
        }
    }

    onClose() {
        if (!this.resolved && this.onRejected) {
            this.onRejected(new Error("User cancelled")); 
        }
        this.isCleaningUp = true;
        if (this.passInputEl) this.passInputEl.value = "";
        if (this.pass1Bytes) { 
            try { if (this.pass1Bytes.buffer.byteLength > 0) this.pass1Bytes.fill(0); } catch {}
            this.pass1Bytes = null; 
        }
        if (this.recoveryManifestBytes) {
            try { this.recoveryManifestBytes.fill(0); } catch {}
            this.recoveryManifestBytes = null;
        }
        if (this.lockoutInterval) {
            clearInterval(this.lockoutInterval);
            this.lockoutInterval = null;
        }
        
        const { contentEl } = this;
        contentEl.empty();
    }
}
