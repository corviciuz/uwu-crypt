import { App, TFile, TFolder, TAbstractFile, Notice, normalizePath } from 'obsidian';
import { VaultManager } from './vaultManager.ts';

export class FileProcessor {
    private activeOperations = new Map<string, Promise<void>>();
    private queue: (() => Promise<void>)[] = [];
    private activeCount = 0;
    private maxConcurrency: number;

    constructor(private plugin: any, private vaultManager: VaultManager, private settings: any) {
        // Adaptive concurrency based on device capabilities
        const hwConcurrency = typeof navigator !== 'undefined' && (navigator as any).hardwareConcurrency;
        this.maxConcurrency = hwConcurrency ? Math.max(1, hwConcurrency - 1) : 2;
    }

    private get app(): App {
        return this.plugin.app;
    }

    /**
     * Проверка: обрабатывается ли файл прямо сейчас.
     * Используется в main.ts для предотвращения перехвата хуками adapter
     * во время шифрования/дешифрования.
     */
    isProcessing(path: string): boolean {
        return this.activeOperations.has(path);
    }

    private async runQueue() {
        if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) return;

        const task = this.queue.shift()!;
        this.activeCount++;
        try {
            await task();
        } catch (err) {
            console.error('Task failed:', err);
        } finally {
            this.activeCount--;
            this.runQueue();
        }
    }

    private enqueue(task: () => Promise<void>) {
        this.queue.push(task);
        this.runQueue();
    }

    async processFile(file: TFile, encrypt: boolean): Promise<void> {
        return new Promise((resolve, reject) => {
            this.enqueue(async () => {
                // Регистрируем активную операцию для isProcessing()
                let opResolve: () => void;
                const opPromise = new Promise<void>(r => { opResolve = r; });
                this.activeOperations.set(file.path, opPromise);
                let result: Uint8Array | null = null;
                try {
                    const data = await this.app.vault.readBinary(file);
                    let plaintext: Uint8Array | null = null;

                    if (encrypt) {
                        plaintext = new Uint8Array(data);
                        const encrypted = await this.vaultManager.encrypt(plaintext, this.settings.zstdLevel);
                        try { if (plaintext.buffer.byteLength > 0) plaintext.fill(0); } catch {}
                        const sig = this.vaultManager.signature;
                        result = new Uint8Array(sig.length + encrypted.length);
                        result.set(sig);
                        result.set(encrypted, sig.length);
                    } else {
                        const sig = this.vaultManager.signature;
                        plaintext = new Uint8Array(data).slice(sig.length);
                        result = await this.vaultManager.decrypt(plaintext);
                        try { if (plaintext.buffer.byteLength > 0) plaintext.fill(0); } catch {}
                    }

                    await this.app.vault.modifyBinary(file, result.buffer as ArrayBuffer);
                    resolve();
                } catch (err: any) {
                    new Notice(`Failed to ${encrypt ? 'encrypt' : 'decrypt'} ${file.path}: ${err.message}`);
                    reject(err);
                } finally {
                    if (result) {
                        try { if (result.buffer.byteLength > 0) result.fill(0); } catch {}
                    }
                    this.activeOperations.delete(file.path);
                    opResolve!();
                }
            });
        });
    }

    async processFolder(folder: TFolder, encrypt: boolean): Promise<void> {
        const files: TFile[] = [];
        const walk = (item: TFolder) => {
            for (const child of item.children) {
                if (child instanceof TFile) {
                    files.push(child);
                } else if (child instanceof TFolder) {
                    if (!this.shouldIgnore(child)) {
                        walk(child);
                    }
                }
            }
        };

        walk(folder);

        if (files.length === 0) return;

        new Notice(`${encrypt ? 'Encrypting' : 'Decrypting'} ${files.length} files...`);
        const promises = files.map(f => this.processFile(f, encrypt));
        await Promise.allSettled(promises);
        new Notice(`Finished ${encrypt ? 'encryption' : 'decryption'}`);
    }

    async processAllVault(encrypt: boolean): Promise<void> {
        await this.processFolder(this.app.vault.getRoot(), encrypt);
    }

    shouldIgnore(folder: TFolder): boolean {
        const name = folder.name;
        return name.startsWith('.') || name === '.uwu' || name === '.obsidian' || name === '.trash';
    }

    shouldIgnorePath(path: string): boolean {
        const parts = path.split('/');
        return parts.some(part => part.startsWith('.') || part === '.uwu' || part === '.obsidian' || part === '.trash');
    }

    shouldEncryptPath(path: string): boolean {
        if (this.shouldIgnorePath(path)) return false;
        if (this.settings.encryptAll) return true;
        if (!this.settings.encryptedFolders || this.settings.encryptedFolders.length === 0) return false;

        return this.settings.encryptedFolders.some((folder: string) => {
            const normalizedFolder = normalizePath(folder);
            if (!normalizedFolder) return false;
            return path.startsWith(normalizedFolder + '/') || path === normalizedFolder;
        });
    }
}
