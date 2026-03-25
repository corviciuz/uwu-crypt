import { App, Plugin, TFile, Notice } from 'obsidian';
import { SetupModal } from './setupModal.ts';

export class VaultManager {
    private worker!: Worker;
    private messageId = 0;
    private pendingMessages = new Map<number, { resolve: Function, reject: Function }>();
    private isLocked = true;
    private sessionTimeoutTimer: number | null = null;
    public signature!: Uint8Array;
    private readyPromise: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (err: Error) => void;
    private unlockPromise: Promise<void> | null = null;

    constructor(private plugin: Plugin) {
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        this.setupWorker();
    }

    private async setupWorker() {
        const workerPath = this.plugin.manifest.dir + '/crypto.worker.js';
        const wasmPath = this.plugin.manifest.dir + '/uwu_crypt_bg.wasm';

        try {
            const [workerContent, wasmContent] = await Promise.all([
                this.plugin.app.vault.adapter.read(workerPath),
                this.plugin.app.vault.adapter.readBinary(wasmPath)
            ]);

            const blob = new Blob([workerContent], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);

            this.worker = new Worker(blobUrl);
            this.worker.onmessage = (e) => {
                const { id, type, payload } = e.data;
                const pending = this.pendingMessages.get(id);
                
                if (type === 'READY') {
                    this.signature = payload.signature;
                    this.resolveReady();
                    if (pending) pending.resolve(payload);
                    this.pendingMessages.delete(id);
                    return;
                }

                if (!pending) return;

                if (type === 'ERROR') {
                    const error = new Error(payload.message || 'Unknown Worker Error');
                    if (id === 0) this.rejectReady(error); // INIT is always id 0
                    pending.reject(error);
                } else {
                    pending.resolve(payload);
                }
                this.pendingMessages.delete(id);
            };
            this.sendMessage('INIT', { wasmBuffer: wasmContent });
        } catch (err: any) {
            this.rejectReady(err);
            new Notice(`Failed to load UWU Crypt Worker: ${err.message}`);
            console.error(err);
        }
    }

    private async sendMessage(type: string, payload?: any): Promise<any> {
        if (type !== 'INIT') await this.readyPromise;
        
        return new Promise((resolve, reject) => {
            const id = this.messageId++;
            this.pendingMessages.set(id, { resolve, reject });
            this.worker.postMessage({ id, type, payload });
        });
    }

    async createVault(pass1: string, pass2: string, m: number, t: number): Promise<Uint8Array> {
        await this.readyPromise;
        const { manifest } = await this.sendMessage('CREATE', { pass1, pass2, m, t });
        await this.saveManifest(manifest);
        this.isLocked = false;
        this.plugin.app.workspace.trigger('uwu-crypt:unlock');
        this.startSessionTimer();
        return manifest;
    }

    async unlockVault(pass1: string, pass2: string): Promise<void> {
        await this.readyPromise;
        const manifest = await this.getManifest();
        if (!manifest) throw new Error('No vault configuration found');
        await this.sendMessage('UNLOCK', { pass1, pass2, payload: manifest });
        this.isLocked = false;
        this.plugin.app.workspace.trigger('uwu-crypt:unlock');
        this.startSessionTimer();
    }

    async lockVault(): Promise<void> {
        await this.sendMessage('LOCK');
        this.isLocked = true;
        this.unlockPromise = null;
        this.plugin.app.workspace.trigger('uwu-crypt:lock');
        if (this.sessionTimeoutTimer) {
            window.clearTimeout(this.sessionTimeoutTimer);
        }
    }

    async requestUnlock(isFirstTime = false): Promise<void> {
        if (!this.isLocked) return;
        if (this.unlockPromise) return this.unlockPromise;

        this.unlockPromise = new Promise((resolve, reject) => {
            const modal = new SetupModal(
                this.plugin.app, 
                this, 
                isFirstTime,
                () => {
                    this.unlockPromise = null;
                    resolve();
                },
                (err) => {
                    this.unlockPromise = null;
                    reject(err);
                }
            );
            modal.open();
        });

        return this.unlockPromise;
    }

    destroy(): void {
        this.worker.terminate();
        if (this.sessionTimeoutTimer) {
            window.clearTimeout(this.sessionTimeoutTimer);
        }
    }

    async testPerformance(m: number, t: number): Promise<number> {
        const start = performance.now();
        await this.sendMessage('TEST_PERF', { m, t });
        return performance.now() - start;
    }

    async encrypt(data: Uint8Array, zstdLevel: number): Promise<Uint8Array> {
        const { data: ciphertext } = await this.sendMessage('ENCRYPT', { data, zstdLevel });
        return ciphertext;
    }

    async decrypt(data: Uint8Array): Promise<Uint8Array> {
        const { data: plaintext } = await this.sendMessage('DECRYPT', { data });
        return plaintext;
    }

    private async saveManifest(manifest: Uint8Array) {
        // Redundancy: .uwu/vault.uwu and plugin data.json
        const base64 = btoa(String.fromCharCode(...manifest));
        
        // Save to .uwu/vault.uwu
        const folder = this.plugin.app.vault.getAbstractFileByPath('.uwu');
        if (!folder) {
            await this.plugin.app.vault.createFolder('.uwu');
        }
        const vaultFile = '.uwu/vault.uwu';
        const existing = this.plugin.app.vault.getAbstractFileByPath(vaultFile);
        if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, base64);
        } else {
            await this.plugin.app.vault.create(vaultFile, base64);
        }

        // Save to data.json
        (this.plugin as any).settings.manifestBackup = base64;
        await (this.plugin as any).saveSettings();
    }

    private async getManifest(): Promise<Uint8Array | null> {
        const vaultFile = '.uwu/vault.uwu';
        const file = this.plugin.app.vault.getAbstractFileByPath(vaultFile);
        let base64: string | null = null;

        if (file instanceof TFile) {
            base64 = (await this.plugin.app.vault.read(file)).trim();
        } else {
            // Restore from backup
            base64 = (this.plugin as any).settings.manifestBackup;
        }

        if (!base64) return null;
        try {
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        } catch (e) {
            console.error("Failed to decode base64 manifest", e);
            return null;
        }
    }

    private startSessionTimer() {
        if (this.sessionTimeoutTimer) window.clearTimeout(this.sessionTimeoutTimer);
        const timeout = (this.plugin as any).settings.sessionTimeout * 60 * 1000;
        if (timeout > 0) {
            this.sessionTimeoutTimer = window.setTimeout(() => {
                this.lockVault();
                new Notice('(⊙ˍ⊙) Session expired');
            }, timeout);
        }
    }

    unlocked() {
        return !this.isLocked;
    }
}
