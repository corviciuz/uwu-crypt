import { FileView, TFile, WorkspaceLeaf, setIcon, MarkdownRenderer, Notice } from "obsidian";
import { VaultManager } from "./vaultManager.ts";

export const UWU_VIEW_TYPE = "uwu-view";

export class UwuView extends FileView {
    constructor(leaf: WorkspaceLeaf, private vaultManager: VaultManager) {
        super(leaf);
    }

    getViewType(): string {
        return UWU_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.file?.name || "Encrypted File";
    }

    private lockedEl: HTMLElement | null = null;
    private decryptedEl: HTMLElement | null = null;
    private errorEl: HTMLElement | null = null;

    async onOpen() {
        this.contentEl.classList.add("uwu-view-container");
        this.render();
    }

    async onClose() {
        this.lockedEl = null;
        this.decryptedEl = null;
        this.errorEl = null;
    }

    async onLoadFile(file: TFile): Promise<void> {
        await super.onLoadFile(file);
        this.render();
    }

    private async render() {
        if (!this.file) return;

        // Check if file is encrypted (signature check)
        const isEncrypted = await this.isEncryptedFile(this.file);
        
        if (!isEncrypted) {
             this.showError("This file is not encrypted.");
             return;
        }

        if (this.vaultManager.unlocked()) {
            await this.renderDecrypted();
        } else {
            this.renderLocked();
        }
    }

    private showError(message: string) {
        if (this.lockedEl) this.lockedEl.style.display = 'none';
        if (this.decryptedEl) this.decryptedEl.style.display = 'none';
        
        if (!this.errorEl) {
            this.errorEl = this.contentEl.createEl("p", { text: message, cls: "uwu-error-message" });
        } else {
            this.errorEl.textContent = message;
            this.errorEl.style.display = 'block';
        }
    }

    private async isEncryptedFile(file: TFile): Promise<boolean> {
        try {
            const buffer = await this.app.vault.readBinary(file);
            const sig = this.vaultManager.signature;
            if (!sig || buffer.byteLength < sig.length) return false;

            const data = new Uint8Array(buffer);
            for (let i = 0; i < sig.length; i++) {
                if (data[i] !== sig[i]) return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    private renderLocked() {
        if (this.decryptedEl) this.decryptedEl.style.display = 'none';
        if (this.errorEl) this.errorEl.style.display = 'none';

        if (!this.lockedEl) {
            this.lockedEl = this.contentEl.createDiv({ cls: "uwu-locked-container" });
            const inner = this.lockedEl.createDiv({ cls: "uwu-locked-content" });
            
            const icon = inner.createDiv({ cls: "uwu-lock-icon-large" });
            setIcon(icon, "lock");
            
            inner.createEl("h2", { text: "File is Encrypted", cls: "uwu-locked-title" });
            inner.createEl("p", { text: "Protected by UWU-Crypt\n(⌐■_■)", cls: "uwu-locked-subtitle" });
            
            const btn = inner.createEl("button", { text: "Unlock Vault", cls: "uwu-unlock-button" });
            btn.addEventListener("click", () => {
                 (this.app as any).commands.executeCommandById("uwu-crypt:unlock-vault");
            });
        } else {
            this.lockedEl.style.display = 'flex';
        }
    }

    private async renderDecrypted() {
        if (this.lockedEl) this.lockedEl.style.display = 'none';
        if (this.errorEl) this.errorEl.style.display = 'none';

        try {
            const encryptedData = await this.app.vault.readBinary(this.file!);
            const sig = this.vaultManager.signature;
            const ciphertext = new Uint8Array(encryptedData).slice(sig.length);
            const plaintext = await this.vaultManager.decrypt(ciphertext);
            const content = new TextDecoder().decode(plaintext);

            if (!this.decryptedEl) {
                this.decryptedEl = this.contentEl.createDiv({ cls: "uwu-decrypted-content" });
            } else {
                this.decryptedEl.empty();
                this.decryptedEl.style.display = 'block';
            }

            // Use Obsidian's MarkdownRenderer for proper preview
            await MarkdownRenderer.render(this.app, content, this.decryptedEl, this.file?.path || "", this);
        } catch (err: any) {
            new Notice(`(⊙ˍ⊙) Decryption failed for ${this.file?.name}: ${err.message}`);
            this.renderLocked();
        }
    }
}
