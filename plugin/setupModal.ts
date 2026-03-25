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
                        .onChange(onChange)
                        .inputEl.type = "password"
                );
            this.inputRows.push(row.settingEl);
            return row;
        };

        createRow("Password 1", "Main key phrase.", "...", (v) => this.pass1 = v);
        createRow("Password 2", "Secondary phrase.", "...", (v) => this.pass2 = v);

        const actionRow = new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText(this.isFirstTime ? "Initialize Vault" : "Unlock")
                    .setCta()
                    .onClick(async () => {
                        this.startProcessing();
                        try {
                            if (this.isFirstTime) {
                                await this.vaultManager.createVault(this.pass1, this.pass2);
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

    private startProcessing() {
        this.inputRows.forEach(row => row.style.display = 'none');
        if (this.progressContainer) this.progressContainer.style.display = 'flex';
        this.animateProgress();
    }

    private showError(msg: string) {
        new Notice(`(⊙ˍ⊙) Error: ${msg}`);
        this.inputRows.forEach(row => row.style.display = '');
        if (this.progressContainer) this.progressContainer.style.display = 'none';
        
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
