import { App, Modal, Setting, Notice } from "obsidian";
import { VaultManager } from "./vaultManager.ts";

export class SetupModal extends Modal {
    private pass1 = "";
    private pass2 = "";
    private resolved = false;
    private progressCircle: SVGCircleElement | null = null;
    private progressText: HTMLElement | null = null;
    private progressContainer: HTMLElement | null = null;
    private inputRows: HTMLElement[] = [];

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
        contentEl.createEl("h2", { text: this.isFirstTime ? "Initialize UWU-Crypt" : "Unlock Vault" });
        
        const description = contentEl.createDiv({ cls: "uwu-setup-description" });
        if (this.isFirstTime) {
            description.createEl("p", { 
                text: "Setting up a new encryption vault. Keep your passwords safe! Losing them means losing your data permanently. (✿◡‿◡)"
            });
        }

        const createRow = (name: string, desc: string, placeholder: string, onChange: (v: string) => void) => {
            const row = new Setting(contentEl)
                .setName(name)
                .setDesc(desc)
                .addText((text) =>
                    text.setPlaceholder(placeholder)
                        .onChange((v) => {
                            onChange(v);
                            this.updateEstimation();
                        })
                        .inputEl.type = "password"
                );
            this.inputRows.push(row.settingEl);
            return row;
        };

        createRow("Password 1", "Main key phrase.", "...", (v) => this.pass1 = v);
        createRow("Password 2", "Secondary phrase.", "...", (v) => this.pass2 = v);

        if (this.isFirstTime) {
            contentEl.createEl("h3", { text: "Argon2id Parameters", attr: { style: "margin-top: 20px;" } });
            
            const mSetting = new Setting(contentEl)
                .setName("Memory (M)")
                .setDesc(`${this.argonM} MB`)
                .addSlider(slider => {
                    slider.setLimits(32, 1024, 32)
                        .setValue(this.argonM)
                        .onChange((v) => {
                            this.argonM = v;
                            mSetting.setDesc(`${v} MB`);
                            this.updateEstimation();
                        });
                    (slider as any).sliderEl.addEventListener('input', (e: any) => {
                        const v = parseInt(e.target.value);
                        this.argonM = v;
                        mSetting.setDesc(`${v} MB`);
                        this.updateEstimation();
                        if (this.testBtn) this.testBtn.textContent = 'Run Dry-run';
                    });
                });

            const tSetting = new Setting(contentEl)
                .setName("Iterations (T)")
                .setDesc(`${this.argonT}`)
                .addSlider(slider => {
                    slider.setLimits(2, 10, 1)
                        .setValue(this.argonT)
                        .onChange((v) => {
                            this.argonT = v;
                            tSetting.setDesc(`${v}`);
                            this.updateEstimation();
                        });
                    (slider as any).sliderEl.addEventListener('input', (e: any) => {
                        const v = parseInt(e.target.value);
                        this.argonT = v;
                        tSetting.setDesc(`${v}`);
                        this.updateEstimation();
                        if (this.testBtn) this.testBtn.textContent = 'Run Dry-run';
                    });
                });

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
                                const time = await this.vaultManager.testPerformance(this.argonM * 1024, this.argonT);
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
            this.updateEstimation();
        }

        const actionRow = new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText(this.isFirstTime ? "Initialize Vault" : "Unlock")
                    .setCta()
                    .onClick(async () => {
                        this.startProcessing();
                        try {
                            if (this.isFirstTime) {
                                await this.vaultManager.createVault(this.pass1, this.pass2, this.argonM * 1024, this.argonT);
                            } else {
                                await this.vaultManager.unlockVault(this.pass1, this.pass2);
                            }
                            this.resolved = true;
                            if (this.onResolved) this.onResolved();
                            this.close();
                        } catch (err: any) {
                            this.showError(err.message);
                        }
                    })
            );
        this.inputRows.push(actionRow.settingEl);

        // Progress UI (Hidden initially)
        this.progressContainer = contentEl.createDiv({ cls: "uwu-progress-container", attr: { style: "display: none;" } });
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.classList.add("uwu-progress-svg");
        
        const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        bg.setAttribute("cx", "50");
        bg.setAttribute("cy", "50");
        bg.setAttribute("r", "40");
        bg.classList.add("uwu-progress-bg");
        
        this.progressCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        this.progressCircle.setAttribute("cx", "50");
        this.progressCircle.setAttribute("cy", "50");
        this.progressCircle.setAttribute("r", "40");
        this.progressCircle.classList.add("uwu-progress-bar");
        
        svg.appendChild(bg);
        svg.appendChild(this.progressCircle);
        this.progressContainer.appendChild(svg);
        this.progressText = this.progressContainer.createDiv({ cls: "uwu-progress-text", text: "Protecting..." });
    }

    private updateEstimation() {
        if (!this.estimationEl) return;
        this.estimationEl.empty();
        
        const combinedPass = this.pass1 + this.pass2;
        if (combinedPass.length === 0) {
            this.estimationEl.createEl("p", { text: "Enter passwords to see brute-force estimation.", attr: { style: "font-style: italic; opacity: 0.7;" } });
            return;
        }

        // 1. Dynamic Entropy Calculation
        let charsetSize = 0;
        if (/[a-z]/.test(combinedPass)) charsetSize += 26;
        if (/[A-Z]/.test(combinedPass)) charsetSize += 26;
        if (/[0-9]/.test(combinedPass)) charsetSize += 10;
        if (/[^a-zA-Z0-9]/.test(combinedPass)) charsetSize += 32;

        const entropy = charsetSize > 0 ? combinedPass.length * Math.log2(charsetSize) : 0;
        const totalCombinations = Math.pow(2, entropy);
        
        // 2. Hardware Capabilities (Memory Bandwidth in Bytes/s)
        const rtx5090Bandwidth = 1792 * 1024 * 1024 * 1024; // 1792 GB/s
        const totalRtxBandwidth = rtx5090Bandwidth * 1000;  // 1000 units
        const frontierBandwidth = 120.3e15; // ~120 PB/s

        // 3. Argon2id Cost (Memory total access per attempt)
        const memorySizeBytes = this.argonM * 1024 * 1024;
        const bytesPerAttempt = memorySizeBytes * 2 * this.argonT;

        // 4. Maximum Throughput
        const thousandRtxRate = totalRtxBandwidth / bytesPerAttempt;
        const frontierRate = frontierBandwidth / bytesPerAttempt;

        const formatTime = (seconds: number) => {
            if (!isFinite(seconds) || seconds > 31536000 * 1e15) return "> 1 quadrillion years";
            if (seconds > 31536000 * 1e9) return `${Math.round(seconds / (31536000 * 1e9))} billion years`;
            if (seconds > 31536000 * 1e6) return `${Math.round(seconds / (31536000 * 1e6))} million years`;
            if (seconds > 31536000) return `${Math.round(seconds / 31536000)} years`;
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
        if (this.progressContainer) this.progressContainer.style.display = 'flex';
        this.animateProgress();
    }

    private showError(msg: string) {
        new Notice(`(⊙ˍ⊙) Error: ${msg}`);
        this.inputRows.forEach(row => row.style.display = '');
        if (this.progressContainer) this.progressContainer.style.display = 'none';
        if (this.estimationEl) this.estimationEl.style.display = 'block';
        
        // Reset progress state for retry
        if (this.progressCircle) {
           this.progressCircle.style.strokeDashoffset = "251.2";
        }
    }

    private animateProgress() {
        let currentProgress = 0;
        const target = 95; // Go up to 95% while waiting for the worker
        const duration = 2000; // Expected duration of Argon2 on mid-range hardware
        const startTime = Date.now();

        const frame = () => {
            if (this.resolved || !this.progressCircle) return;
            
            const elapsed = Date.now() - startTime;
            currentProgress = Math.min(target, (elapsed / duration) * target);
            
            this.updateCircle(currentProgress);
            if (currentProgress < target) {
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
            this.onRejected(new Error("User cancelled vault unlock"));
        }
        // Zeroize passwords on modal close
        this.pass1 = "";
        this.pass2 = "";
        
        const { contentEl } = this;
        contentEl.empty();
    }
}
