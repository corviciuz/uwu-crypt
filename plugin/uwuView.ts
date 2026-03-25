import { FileView, TFile, WorkspaceLeaf, setIcon, MarkdownRenderer } from "obsidian";
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

    async onOpen() {
        this.render();
    }

    async onLoadFile(file: TFile): Promise<void> {
        await super.onLoadFile(file);
        this.render();
    }

    private async render() {
        const container = this.contentEl;
        container.empty();
        container.classList.add("uwu-view-container");

        if (!this.file) return;

        // Check if file is encrypted (signature check)
        const isEncrypted = await this.isEncryptedFile(this.file);
        
        if (!isEncrypted) {
             container.createEl("p", { text: "This file is not encrypted." });
             return;
        }

        if (this.vaultManager.unlocked()) {
            await this.renderDecrypted();
        } else {
            this.renderLocked();
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
        const div = this.contentEl.createDiv({ cls: "uwu-locked-ui" });
        const icon = div.createDiv({ cls: "uwu-lock-icon" });
        setIcon(icon, "lock");
        
        div.createEl("p", { text: "This file is encrypted." });
        const btn = div.createEl("button", { text: "Unlock Vault" });
        btn.addEventListener("click", () => {
             (this.app as any).commands.executeCommandById("uwu-crypt:unlock-vault");
        });
    }

    private async renderDecrypted() {
        try {
            const encryptedData = await this.app.vault.readBinary(this.file!);
            const sig = this.vaultManager.signature;
            const ciphertext = new Uint8Array(encryptedData).slice(sig.length);
            const plaintext = await this.vaultManager.decrypt(ciphertext);
            const content = new TextDecoder().decode(plaintext);

            const div = this.contentEl.createDiv({ cls: "uwu-decrypted-content" });
            // Use Obsidian's MarkdownRenderer for proper preview
            await MarkdownRenderer.render(this.app, content, div, this.file?.path || "", this);
        } catch (err: any) {
            this.contentEl.createEl("p", { text: `Decryption failed: ${err.message}`, cls: "error" });
        }
    }
}
