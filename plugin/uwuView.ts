import { FileView, TFile, WorkspaceLeaf, setIcon, MarkdownRenderer, Notice } from "obsidian";
import { VaultManager } from "./vaultManager.ts";

export const UWU_VIEW_TYPE = "uwu-view";

export class UwuView extends FileView {
    // Must be the ORIGINAL (unpatched) readBinary to always get raw encrypted bytes
    public originalReadBinary?: (path: string) => Promise<ArrayBuffer>;

    constructor(leaf: WorkspaceLeaf, private vaultManager: VaultManager) {
        super(leaf);
    }

    getViewType(): string {
        return UWU_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.file?.name || "Encrypted File";
    }

    getState(): Record<string, unknown> {
        return { file: this.file?.path ?? "" };
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

    async render() {
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

    static async applyToLeaf(leaf: WorkspaceLeaf, file: TFile) {
        const leafView = leaf.view as any;
        // Check if this leaf is already viewing this file in some form
        if (leafView.file === file || leaf.getViewState()?.state?.file === file.path || leaf.getViewState()?.state?.path === file.path) {
            if (leaf.view.getViewType() !== UWU_VIEW_TYPE) {
                await leaf.setViewState({
                    type: UWU_VIEW_TYPE,
                    state: { file: file.path },
                }, { history: false });
            }
        }
    }

    private async isEncryptedFile(file: TFile): Promise<boolean> {
        try {
            await (this.vaultManager as any).readyPromise;
            // Use original (unpatched) adapter to always get raw encrypted bytes
            const readRaw = this.originalReadBinary ?? this.app.vault.adapter.readBinary.bind(this.app.vault.adapter);
            const buffer = await readRaw(file.path);
            return this.vaultManager.isEncrypted(buffer);
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
                 this.vaultManager.requestUnlock().catch(() => {});
            });
        } else {
            this.lockedEl.style.display = 'flex';
        }
    }

    private async renderDecrypted() {
        if (this.lockedEl) this.lockedEl.style.display = 'none';
        if (this.errorEl) this.errorEl.style.display = 'none';

        const ext = this.file?.extension.toLowerCase() || "";
        const textExtensions = ["md", "txt", "task", "canvas"];
        const isText = textExtensions.includes(ext);

        if (!isText) {
             // If decrypted and binary, just tell Obsidian to switch to the native viewer
             const viewType = (this.app as any).viewRegistry?.getTypeByExtension(ext) || "markdown";
             this.leaf.setViewState({
                 type: viewType,
                 state: this.getState(),
                 popstate: true
             } as any);
             return;
        }

        try {
            // Always read raw encrypted bytes via original adapter — patched readBinary decrypts transparently
            // which would cause double-decryption corruption
            const readRaw = this.originalReadBinary ?? this.app.vault.adapter.readBinary.bind(this.app.vault.adapter);
            const encryptedData = await readRaw(this.file!.path);
            const sig = this.vaultManager.signature;
            const ciphertext = new Uint8Array(encryptedData).slice(sig.length);
            const plaintext = await this.vaultManager.decrypt(ciphertext);
            const content = new TextDecoder().decode(plaintext);
            try { if (plaintext.buffer.byteLength > 0) plaintext.fill(0); } catch {}

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

    static renderMediaPlaceholder(el: HTMLElement) {
        if (el.getAttribute('data-uwu-hidden') === 'true' || el.hasClass('uwu-media-locked-placeholder')) return;
        
        el.setAttribute('data-uwu-hidden', 'true');
        el.setAttribute('data-uwu-original-display', el.style.display);
        
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || el.tagName === 'IFRAME' || el.tagName === 'EMBED') {
            el.style.display = 'none';
            const wrapper = el.ownerDocument.createElement('div');
            el.insertAdjacentElement('afterend', wrapper);
            this.buildMediaLockUI(wrapper);
            wrapper.setAttribute('data-uwu-placeholder-child', 'false');
        } else {
            if (el.style.backgroundImage) {
                el.setAttribute('data-uwu-original-bg', el.style.backgroundImage);
                el.style.backgroundImage = 'none';
            }
            
            Array.from(el.children).forEach((child: Element) => {
                if (child instanceof HTMLElement) {
                    child.setAttribute('data-uwu-child-display', child.style.display);
                    child.style.display = 'none';
                }
            });
            
            const wrapper = el.ownerDocument.createElement('div');
            el.appendChild(wrapper);
            this.buildMediaLockUI(wrapper);
            wrapper.setAttribute('data-uwu-placeholder-child', 'true');
        }
    }

    private static buildMediaLockUI(container: HTMLElement) {
        container.addClass("uwu-media-locked-placeholder");
        container.style.display = "flex";
        container.style.alignItems = "center";
        container.style.justifyContent = "center";
        container.style.height = "50px";
        container.style.width = "100%";
        container.style.maxWidth = "400px";
        container.style.background = "transparent";
        container.style.border = "1px dashed var(--text-faint)";
        container.style.borderRadius = "8px";
        container.style.color = "var(--text-muted)";
        container.style.fontFamily = "var(--font-text)";
        container.style.fontSize = "1em";
        container.style.opacity = "0.8";
        container.style.margin = "10px 0";
        
        container.setText("(⌐■_■) Media is Encrypted");
    }
}
