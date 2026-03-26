import { App, TFile, TFolder, TAbstractFile, Notice, normalizePath } from 'obsidian';
import { VaultManager } from './vaultManager.ts';

export class FileProcessor {
    private queue: (() => Promise<void>)[] = [];
    private activeCount = 0;
    private maxConcurrency = 2;

    constructor(private plugin: any, private vaultManager: VaultManager, private settings: any) {}

    private get app(): App {
        return this.plugin.app;
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
                try {
                    this.plugin.processingPaths.add(file.path);
                    const data = await this.app.vault.readBinary(file);
                    let result: Uint8Array;
                    
                    if (encrypt) {
                        const encrypted = await this.vaultManager.encrypt(new Uint8Array(data), this.settings.zstdLevel);
                        const sig = this.vaultManager.signature;
                        result = new Uint8Array(sig.length + encrypted.length);
                        result.set(sig);
                        result.set(encrypted, sig.length);
                    } else {
                        const sig = this.vaultManager.signature;
                        const ciphertext = new Uint8Array(data).slice(sig.length);
                        result = await this.vaultManager.decrypt(ciphertext);
                    }

                    await this.app.vault.modifyBinary(file, result.buffer as ArrayBuffer);
                    
                    this.plugin.processingPaths.delete(file.path);

                    // The modify event handler in main.ts will handle the forceful refresh
                    resolve();
                } catch (err: any) {
                    new Notice(`Failed to ${encrypt ? 'encrypt' : 'decrypt'} ${file.path}: ${err.message}`);
                    reject(err);
                } finally {
                    this.plugin.processingPaths.delete(file.path);
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
