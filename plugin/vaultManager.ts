import { App, Plugin, TFile, Notice } from 'obsidian';
import { SetupModal } from './setupModal.ts';

export class VaultManager {
    private worker!: Worker;
    private messageId = 0;
    private pendingMessages = new Map<number, { resolve: Function, reject: Function, onProgress?: (p: number) => void }>();
    private isLocked = true;
    private sessionTimeoutTimer: number | null = null;
    public signature!: Uint8Array;
    private failedAttempts = 0;
    private readonly backoffDelays = [0, 0, 5000, 10000, 30000, 60000, 180000, 300000]; // ms: 0, 0, 5с, 10с, 30с, 60с, 3м, 5м
    private lockoutUntil: number = 0; // timestamp когда разблокируется ввод
    private lockoutCallback: (() => void) | null = null;
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
            this.workerBlobUrl = URL.createObjectURL(blob);

            this.worker = new Worker(this.workerBlobUrl);
            this.worker.onmessage = (e) => {
                const { id, type, payload } = e.data;
                const pending = this.pendingMessages.get(id);

                if (type === 'PROGRESS') {
                    if (pending?.onProgress) pending.onProgress(payload.progress);
                    return;
                }

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
            this.worker.onerror = (e) => {
                console.error('UWU-Crypt: Worker crashed', e);
                for (const [, pending] of this.pendingMessages) {
                    pending.reject(new Error('Crypto worker crashed'));
                }
                this.pendingMessages.clear();
            };
            this.sendMessage('INIT', { wasmBuffer: wasmContent });
        } catch (err: any) {
            this.rejectReady(err);
            new Notice(`(⊙ˍ⊙) Failed to load UWU Crypt Worker: ${err.message}`);
            console.error(err);
        }
    }

    private async sendMessage(type: string, payload?: any, onProgress?: (p: number) => void): Promise<any> {
        if (type !== 'INIT') await this.readyPromise;

        return new Promise((resolve, reject) => {
            const id = this.messageId++;
            this.pendingMessages.set(id, { resolve, reject, onProgress });

            // Use Transfer Lists for memory safety and performance
            const transfers: Transferable[] = [];
            if (payload) {
                if (payload.password instanceof Uint8Array) transfers.push(payload.password.buffer);
                if (payload.data instanceof Uint8Array) transfers.push(payload.data.buffer);
                if (payload.wasmBuffer instanceof ArrayBuffer) transfers.push(payload.wasmBuffer);
                // Manifest transfer for zeroization in worker
                if (payload.payload instanceof Uint8Array) transfers.push(payload.payload.buffer);
            }

            this.worker.postMessage({ id, type, payload }, transfers);
        });
    }

    async createVault(password: Uint8Array, m: number, t: number, onProgress?: (p: number) => void): Promise<Uint8Array> {
        await this.readyPromise;
        const { manifest } = await this.sendMessage('CREATE', { password, m, t }, onProgress);
        try { if (password.buffer.byteLength > 0) password.fill(0); } catch {}
        
        await this.saveManifest(manifest);
        
        // Finalize backup in settings
        (this.plugin as any).settings.manifestBackup = this.uint8ToBase64(manifest);
        await (this.plugin as any).saveSettings();

        this.isLocked = false;
        this.plugin.app.workspace.trigger('uwu-crypt:unlock');
        this.startSessionTimer();
        return manifest;
    }

    async unlockVault(password: Uint8Array, onProgress?: (p: number) => void, manifestOverride?: Uint8Array): Promise<void> {
        await this.readyPromise;

        const remaining = this.getLockoutRemaining();
        if (remaining > 0) {
            throw new Error(`LOCKED: ${remaining}`);
        }

        let manifest = manifestOverride || await this.getManifest();
        if (!manifest) throw new Error('No vault configuration found');

        // Clone manifest before transfer — worker will detach the original buffer
        const manifestClone = new Uint8Array(manifest);

        try {
            await this.sendMessage('UNLOCK', { password, payload: manifest }, onProgress);
            this.failedAttempts = 0;
            // If we got here, the manifest is cryptographically verified (Argon2 check inside WASM passed)
            // --- HMAC OK! START SYNC / RESTORATION ---
            const m_b64 = this.uint8ToBase64(manifestClone);
            const settings = (this.plugin as any).settings;

            // 1. Sync Backup if missing or broken or different
            let backupValid = false;
            try {
                const b_raw = this.base64ToUint8(settings.manifestBackup || "");
                if (this.isManifestHealthy(b_raw) && this.arraysEqual(manifestClone, b_raw)) backupValid = true;
            } catch {}

            if (!backupValid || manifestOverride) {
                settings.manifestBackup = m_b64;
                await (this.plugin as any).saveSettings();
                console.log('UWU-Crypt: Settings backup synchronized' + (manifestOverride ? ' (BYOM)' : ''));
            }

            // 2. Sync Physical File if missing, broken, different, or forced via manifestOverride
            const adapter = this.plugin.app.vault.adapter;
            const vaultFile = '.uwu/vault.uwu';
            let fileValid = false;
            if (manifestOverride === undefined) { // If it's NOT an import/BYM, check current file
                try {
                    if (await adapter.exists(vaultFile)) {
                        const content = await adapter.read(vaultFile);
                        const v_raw = this.base64ToUint8(content.trim());
                        if (this.isManifestHealthy(v_raw) && this.arraysEqual(manifestClone, v_raw)) fileValid = true;
                    }
                } catch {}
            }

            if (!fileValid) {
                await this.saveManifest(manifestClone);
                if (manifestOverride) {
                    new Notice('(⌐■_■) Vault initialized with your manifest');
                } else {
                    console.log('UWU-Crypt: Physical manifest restored/updated after HMAC check');
                }
            }

            this.isLocked = false;
            this.plugin.app.workspace.trigger('uwu-crypt:unlock');
            this.startSessionTimer();
        } catch (e) {
            this.failedAttempts++;
            if (this.failedAttempts >= 3) {
                const delayIndex = Math.min(this.failedAttempts - 1, this.backoffDelays.length - 1);
                const delayMs = this.backoffDelays[delayIndex];
                this.lockoutUntil = Date.now() + delayMs;
            }
            throw e;
        } finally {
            try { if (password.buffer.byteLength > 0) password.fill(0); } catch {}
            try { if (manifestClone.byteLength > 0) manifestClone.fill(0); } catch {}
        }
    }

    getLockoutRemaining(): number {
        if (this.lockoutUntil <= 0) return 0;
        const remaining = this.lockoutUntil - Date.now();
        if (remaining <= 0) {
            this.lockoutUntil = 0;
            return 0;
        }
        return remaining;
    }

    onLockoutReady(callback: () => void): void {
        this.lockoutCallback = callback;
    }

    notifyLockoutReady(): void {
        if (this.lockoutCallback) {
            this.lockoutCallback();
            this.lockoutCallback = null;
        }
    }

    async lockVault(): Promise<void> {
        try {
            await this.sendMessage('LOCK');
        } catch {
            // Worker may already be dead or unresponsive — proceed to cleanup regardless
        } finally {
            // Reject all pending — worker will not respond after LOCK
            for (const [, pending] of this.pendingMessages) {
                pending.reject(new Error('Vault locked'));
            }
            this.pendingMessages.clear();
            this.isLocked = true;
            this.unlockPromise = null;
            this.plugin.app.workspace.trigger('uwu-crypt:lock');
            if (this.sessionTimeoutTimer) {
                window.clearTimeout(this.sessionTimeoutTimer);
                this.sessionTimeoutTimer = null;
            }
        }

        if ((this.plugin as any).settings.webEngineReload) {
            new Notice('(⌐■_■) WebEngine Reload! Wiping memory and reloading...', 2000);
            // Delay long enough for the cleanup above to fully settle before reload destroys the context
            setTimeout(() => {
                (this.plugin.app as any).commands.executeCommandById('app:reload');
            }, 300);
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

    private workerBlobUrl: string | null = null;

    destroy(): void {
        // Reject all pending
        for (const [, pending] of this.pendingMessages) {
            pending.reject(new Error('Worker destroyed'));
        }
        this.pendingMessages.clear();
        this.worker.terminate();
        if (this.workerBlobUrl) {
            URL.revokeObjectURL(this.workerBlobUrl);
            this.workerBlobUrl = null;
        }
        if (this.sessionTimeoutTimer) {
            window.clearTimeout(this.sessionTimeoutTimer);
        }
    }

    async testPerformance(m: number, t: number, onProgress?: (p: number) => void): Promise<number> {
        const start = performance.now();
        await this.sendMessage('TEST_PERF', { m, t }, onProgress);
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

    private readonly MIN_MANIFEST_SIZE = 64; // signature (16) + auth_hash (32) + salts + msgpack overhead

    public isManifestHealthy(data: Uint8Array | null): boolean {
        if (!data || data.length < this.MIN_MANIFEST_SIZE) return false;
        
        // 1. Check for all zeros
        let allZeros = true;
        for (let i = 0; i < Math.min(data.length, 100); i++) {
            if (data[i] !== 0) { allZeros = false; break; }
        }
        if (allZeros) return false;

        if (!this.signature) return true; // If signature unknown yet, just trust size

        // 2. Search for the 16-byte signature within first chunk
        const sig = this.signature;
        for (let i = 0; i < Math.min(16, data.length - sig.length); i++) {
            let match = true;
            for (let j = 0; j < sig.length; j++) {
                if (data[i + j] !== sig[j]) { match = false; break; }
            }
            if (match) return true;
        }
        return false;
    }

    private async saveManifest(manifest: Uint8Array) {
        const adapter = this.plugin.app.vault.adapter;
        const vaultFile = '.uwu/vault.uwu';
        const folder = '.uwu';

        // 1. Create folder if missing
        if (!(await adapter.exists(folder))) {
            await adapter.mkdir(folder);
        }

        // 2. Save Base64 to physical file
        const base64 = this.uint8ToBase64(manifest);
        await adapter.write(vaultFile, base64);

        // 3. Save to settings backup
        (this.plugin as any).settings.manifestBackup = base64;
        await (this.plugin as any).saveSettings();
    }

    private async getManifest(): Promise<Uint8Array | null> {
        const adapter = this.plugin.app.vault.adapter;
        const vaultFile = '.uwu/vault.uwu';
        
        // 1. Try physical file
        try {
            if (await adapter.exists(vaultFile)) {
                const content = await adapter.read(vaultFile);
                const v_raw = this.base64ToUint8(content.trim());
                if (this.isManifestHealthy(v_raw)) return v_raw;
            }
        } catch (e) {
            console.warn('Physical manifest load/health check failed:', e);
        }

        // 2. Fallback to settings backup
        const b_base64 = (this.plugin as any).settings.manifestBackup;
        if (b_base64) {
            try { 
                const b_raw = this.base64ToUint8(b_base64.trim()); 
                if (this.isManifestHealthy(b_raw)) return b_raw;
            } catch {}
        }

        return null;
    }

    public uint8ToBase64(arr: Uint8Array): string {
        let binary = '';
        const len = arr.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(arr[i]);
        }
        return btoa(binary);
    }

    public base64ToUint8(base64: string): Uint8Array {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    private arraysEqual(a: Uint8Array, b: Uint8Array | null): boolean {
        if (!b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
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

    public isEncrypted(buffer: ArrayBufferLike): boolean {
        if (!this.signature || buffer.byteLength < this.signature.length) return false;
        const data = new Uint8Array(buffer);
        for (let i = 0; i < this.signature.length; i++) {
            if (data[i] !== this.signature[i]) return false;
        }
        return true;
    }
}
