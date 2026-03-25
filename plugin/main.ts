import { Plugin, PluginSettingTab, App, Setting, TFile, TFolder, Menu, Notice, WorkspaceLeaf, TAbstractFile, DataWriteOptions, setIcon } from 'obsidian';
import { VaultManager } from './vaultManager.ts';
import { FileProcessor } from './fileProcessor.ts';
import { UwuView, UWU_VIEW_TYPE } from './uwuView.ts';
import { SetupModal } from './setupModal.ts';
import { ImageProcessor } from './imageProcessor.ts';

interface UwuCryptSettings {
    rememberPassword: boolean;
    sessionTimeout: number; // in minutes
    zstdLevel: number;
    encryptAll: boolean;
    encryptedFolders: string[];
    manifestBackup: string | null;
}

const DEFAULT_SETTINGS: UwuCryptSettings = {
    rememberPassword: true,
    sessionTimeout: 20,
    zstdLevel: 8,
    encryptAll: false,
    encryptedFolders: [],
    manifestBackup: null
};

export default class UwuCryptPlugin extends Plugin {
    settings!: UwuCryptSettings;
    vaultManager!: VaultManager;
    fileProcessor!: FileProcessor;
    imageProcessor!: ImageProcessor;
    isProcessing = false;

    private originalAdapterRead!: any;
    private originalAdapterReadBinary!: any;
    private originalAdapterWrite!: any;
    private originalAdapterWriteBinary!: any;
    private originalAdapterProcess!: any;
    private originalAdapterMkdir!: any;
    private originalAdapterRemove!: any;
    private originalAdapterTrashLocal!: any;
    private originalAdapterTrashSystem!: any;
    private originalAdapterRmdir!: any;
    private originalAdapterRename!: any;
    private ribbonIconEl!: HTMLElement;
    private lazyImageObserver!: IntersectionObserver;
    private originalSetViewState!: any;

    private decryptionCache = new Map<string, Promise<{ data: Uint8Array, mask: Uint8Array }>>();

    async onload() {
        await this.loadSettings();

        this.vaultManager = new VaultManager(this);
        this.fileProcessor = new FileProcessor(this, this.vaultManager, this.settings);
        this.imageProcessor = new ImageProcessor(this, this.vaultManager, this.isEncrypted.bind(this));

        this.registerView(
            UWU_VIEW_TYPE,
            (leaf) => new UwuView(leaf, this.vaultManager)
        );

        // Hook DataAdapter for transparent encryption/decryption
        this.setupHooks();

        // Image rendering support
        this.registerMarkdownPostProcessor((el, ctx) => {
            const images = el.querySelectorAll('img');
            images.forEach(async (img) => {
                const src = img.getAttribute('src');
                if (src && (src.startsWith('app://') || !src.includes('://'))) {
                    const path = ctx.sourcePath;
                    // Try to find the file in the vault
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, path);
                    if (file instanceof TFile && this.isImage(file)) {
                        const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
                        if (blobUrl) {
                            img.src = blobUrl;
                        }
                    }
                }
            });
        });

        this.setupImageObserver();
        this.setupLazyImageObserver();

        this.ribbonIconEl = this.addRibbonIcon('unlock', 'Unlock Vault', () => {
            if (this.vaultManager.unlocked()) {
                this.vaultManager.lockVault();
            } else {
                this.vaultManager.requestUnlock();
            }
        });

        this.registerEvent(this.app.workspace.on('uwu-crypt:lock' as any, () => this.updateRibbon()));
        this.registerEvent(this.app.workspace.on('uwu-crypt:unlock' as any, () => this.updateRibbon()));
        this.updateRibbon();

        this.addCommand({
            id: 'unlock-vault',
            name: 'Unlock Vault',
            callback: () => {
                this.vaultManager.requestUnlock();
            }
        });

        this.setupLeafHooks();

        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (file instanceof TFile && this.vaultManager.unlocked()) {
                    const shouldEncrypt = this.fileProcessor.shouldEncryptPath(file.path);
                    const buffer = await this.originalAdapterReadBinary.call(this.app.vault.adapter, file.path);
                    const isEncrypted = this.isEncrypted(buffer);

                    if (shouldEncrypt && !isEncrypted) {
                        await this.fileProcessor.processFile(file, true);
                        new Notice(`(⌐■_■) Protected moved file ${file.name}`);
                    }
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', async (file) => {
                if (file instanceof TFile && this.vaultManager.unlocked()) {
                    const shouldEncrypt = this.fileProcessor.shouldEncryptPath(file.path);
                    if (shouldEncrypt) {
                        const buffer = await this.originalAdapterReadBinary.call(this.app.vault.adapter, file.path);
                        if (!this.isEncrypted(buffer)) {
                            await this.fileProcessor.processFile(file, true);
                        }
                    }
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item.setTitle('Encrypt File')
                            .setIcon('lock')
                            .onClick(async () => {
                                await this.fileProcessor.processFile(file, true);
                                new Notice(`(⌐■_■) Encrypted file ${file.name}`);
                            });
                    });
                    menu.addItem((item) => {
                        item.setTitle('Decrypt File')
                            .setIcon('unlock')
                            .onClick(async () => {
                                await this.fileProcessor.processFile(file, false);
                                new Notice(`( •_•)>⌐■-■ Decrypted file ${file.name}`);
                            });
                    });
                } else if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle('Encrypt Folder Recursively')
                            .setIcon('lock')
                            .onClick(async () => {
                                await this.fileProcessor.processFolder(file, true);
                                new Notice(`(⌐■_■) Encrypted folder ${file.name}`);
                            });
                    });
                    menu.addItem((item) => {
                        item.setTitle('Decrypt Folder Recursively')
                            .setIcon('unlock')
                            .onClick(async () => {
                                await this.fileProcessor.processFolder(file, false);
                                new Notice(`( •_•)>⌐■-■ Decrypted folder ${file.name}`);
                            });
                    });
                }
            })
        );

        this.addSettingTab(new UwuCryptSettingTab(this.app, this));

        // Listen for lock/unlock to refresh views
        this.registerEvent(this.app.workspace.on('uwu-crypt:unlock' as any, () => {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view.getViewType() === UWU_VIEW_TYPE) {
                    const file = (leaf.view as any).file;
                    if (file instanceof TFile) {
                        const viewType = (this.app as any).viewRegistry?.getTypeByExtension(file.extension) || 'markdown';
                        leaf.setViewState({
                            type: viewType,
                            state: leaf.view.getState(),
                            popstate: true
                        } as any);
                    }
                }
            });
            new Notice('(*￣︶￣)/ Vault Unlocked');
        }));

        this.registerEvent(this.app.workspace.on('uwu-crypt:lock' as any, () => {
            // 1. Physically zeroize decrypted buffers before clearing
            const entries = Array.from(this.decryptionCache.values());
            for (const promise of entries) {
                try {
                    promise.then(({ data, mask }) => {
                        data.fill(0);
                        mask.fill(0);
                    });
                } catch {}
            }
            this.decryptionCache.clear();

            // 2. Refresh views (Switch ALL relevant leaves to UwuView/Locked state)
            this.app.workspace.iterateAllLeaves((leaf) => {
                const file = (leaf.view as any).file;
                if (file instanceof TFile && leaf.view.getViewType() !== UWU_VIEW_TYPE) {
                    if (this.fileProcessor.shouldEncryptPath(file.path)) {
                        this.activateUwuView(file);
                    }
                }
            });
            new Notice('(・∀・)ノ Vault Locked');
            this.imageProcessor.clearCache();
            this.isProcessing = false;
        }));

        // Initial Setup Modal Check (only if no vault exists)
        this.app.workspace.onLayoutReady(async () => {
            const hasConfig = this.app.vault.getAbstractFileByPath('.uwu/vault.uwu') || this.settings.manifestBackup;
            if (!hasConfig) {
                this.vaultManager.requestUnlock(true);
            }
        });
    }

    private updateRibbon() {
        if (!this.ribbonIconEl) return;
        const unlocked = this.vaultManager.unlocked();
        setIcon(this.ribbonIconEl, unlocked ? 'lock' : 'unlock');
        this.ribbonIconEl.setAttribute('aria-label', unlocked ? 'Lock Vault' : 'Unlock Vault');
    }

    private setupLeafHooks() {
        const self = this;
        this.originalSetViewState = WorkspaceLeaf.prototype.setViewState;
        
        WorkspaceLeaf.prototype.setViewState = function(viewState: any, result?: any) {
            if (!self.vaultManager.unlocked()) {
                const file = viewState.state?.file;
                if (viewState.type !== UWU_VIEW_TYPE && file && self.fileProcessor.shouldEncryptPath(file)) {
                    viewState.type = UWU_VIEW_TYPE;
                }
            }
            return self.originalSetViewState.call(this, viewState, result);
        };
    }

    private setupHooks() {
        const adapter = this.app.vault.adapter;
        
        this.originalAdapterRead = adapter.read;
        this.originalAdapterReadBinary = adapter.readBinary;
        this.originalAdapterWrite = adapter.write;
        this.originalAdapterWriteBinary = (adapter as any).writeBinary;
        this.originalAdapterProcess = adapter.process;
        this.originalAdapterMkdir = adapter.mkdir;
        this.originalAdapterRemove = adapter.remove;
        this.originalAdapterTrashLocal = adapter.trashLocal;
        this.originalAdapterTrashSystem = adapter.trashSystem;
        this.originalAdapterRmdir = adapter.rmdir;
        this.originalAdapterRename = adapter.rename;

        const blockIfLocked = async (path: string, action: string) => {
            if (!this.isProcessing && this.fileProcessor.shouldEncryptPath(path) && !this.vaultManager.unlocked()) {
                throw new Error(`(⌐■_■) Vault is locked. Unlock to ${action} ${path}`);
            }
        };

        adapter.mkdir = async (path: string): Promise<void> => {
            await blockIfLocked(path, "create folder");
            return this.originalAdapterMkdir.call(adapter, path);
        };

        adapter.remove = async (path: string): Promise<void> => {
            await blockIfLocked(path, "delete");
            return this.originalAdapterRemove.call(adapter, path);
        };

        adapter.trashLocal = async (path: string): Promise<void> => {
            await blockIfLocked(path, "trash");
            return this.originalAdapterTrashLocal.call(adapter, path);
        };

        adapter.trashSystem = async (path: string): Promise<boolean> => {
            await blockIfLocked(path, "trash");
            return this.originalAdapterTrashSystem.call(adapter, path);
        };

        adapter.rmdir = async (path: string, recursive: boolean): Promise<void> => {
            await blockIfLocked(path, "delete folder");
            return this.originalAdapterRmdir.call(adapter, path, recursive);
        };

        adapter.rename = async (path: string, newPath: string): Promise<void> => {
            await blockIfLocked(path, "move/rename");
            await blockIfLocked(newPath, "move/rename to");
            return this.originalAdapterRename.call(adapter, path, newPath);
        };

        adapter.read = async (path: string): Promise<string> => {
            try {
                const buffer = await this.originalAdapterReadBinary.call(adapter, path);
                if (!this.isProcessing && this.isEncrypted(buffer)) {
                    if (!this.vaultManager.unlocked()) {
                        return "%% (⊙ˍ⊙) File is locked. Please unlock the vault to view this content. %%";
                    }
                    const { data, mask } = await this.getCachedDecryption(path, buffer);
                    const unmasked = new Uint8Array(data);
                    this.maskData(unmasked, mask);
                    const text = new TextDecoder().decode(unmasked);
                    unmasked.fill(0);
                    return text;
                }
            } catch {}
            return this.originalAdapterRead.call(adapter, path);
        };

        adapter.readBinary = async (path: string): Promise<ArrayBuffer> => {
            const buffer = await this.originalAdapterReadBinary.call(adapter, path);
            if (!this.isProcessing && this.isEncrypted(buffer)) {
                if (!this.vaultManager.unlocked()) {
                    return buffer; // Return encrypted data if locked
                }
                const { data, mask } = await this.getCachedDecryption(path, buffer);
                const unmasked = new Uint8Array(data);
                this.maskData(unmasked, mask);
                const result = unmasked.buffer.slice(unmasked.byteOffset, unmasked.byteOffset + unmasked.byteLength) as ArrayBuffer;
                unmasked.fill(0);
                return result;
            }
            return buffer;
        };

        adapter.write = async (path: string, data: string, options?: DataWriteOptions): Promise<void> => {
            if (!this.isProcessing && this.fileProcessor.shouldEncryptPath(path)) {
                await blockIfLocked(path, "write to");
                const buffer = new TextEncoder().encode(data);
                const encrypted = await this.vaultManager.encrypt(buffer, this.settings.zstdLevel);
                
                const sig = this.vaultManager.signature;
                const combined = new Uint8Array(sig.length + encrypted.length);
                combined.set(sig);
                combined.set(encrypted, sig.length);
                
                return this.originalAdapterWriteBinary.call(adapter, path, combined.buffer, options);
            }
            return this.originalAdapterWrite.call(adapter, path, data, options);
        };

        (adapter as any).writeBinary = async (path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> => {
            if (!this.isProcessing && this.fileProcessor.shouldEncryptPath(path)) {
                await blockIfLocked(path, "write binary to");
                const encrypted = await this.vaultManager.encrypt(new Uint8Array(data), this.settings.zstdLevel);
                
                const sig = this.vaultManager.signature;
                const combined = new Uint8Array(sig.length + encrypted.length);
                combined.set(sig);
                combined.set(encrypted, sig.length);
                
                return this.originalAdapterWriteBinary.call(adapter, path, combined.buffer, options);
            }
            return this.originalAdapterWriteBinary.call(adapter, path, data, options);
        };

        adapter.process = async (path: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> => {
            if (!this.isProcessing && (this.fileProcessor.shouldEncryptPath(path) || this.isEncrypted(await this.originalAdapterReadBinary.call(adapter, path)))) {
                 // Vault must be unlocked to process encrypted files
                await blockIfLocked(path, "process");
                const content = await adapter.read(path);
                const result = fn(content);
                await adapter.write(path, result, options);
                return result;
            }
            return this.originalAdapterProcess.call(adapter, path, fn, options);
        };

        (adapter as any).append = async (path: string, data: string, options?: DataWriteOptions): Promise<void> => {
            if (!this.isProcessing && (this.fileProcessor.shouldEncryptPath(path) || this.isEncrypted(await this.originalAdapterReadBinary.call(adapter, path)))) {
                await blockIfLocked(path, "append to");
                const content = await adapter.read(path);
                return adapter.write(path, content + data, options);
            }
            return (this.app.vault.adapter as any).append.call(adapter, path, data, options);
        };

        (adapter as any).appendBinary = async (path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> => {
            if (!this.isProcessing && (this.fileProcessor.shouldEncryptPath(path) || this.isEncrypted(await this.originalAdapterReadBinary.call(adapter, path)))) {
                await blockIfLocked(path, "append binary to");
                const content = await adapter.readBinary(path);
                const combined = new Uint8Array(content.byteLength + data.byteLength);
                combined.set(new Uint8Array(content));
                combined.set(new Uint8Array(data), content.byteLength);
                return adapter.writeBinary(path, combined.buffer, options);
            }
            return (this.app.vault.adapter as any).appendBinary.call(adapter, path, data, options);
        };

        (adapter as any).copy = async (path: string, newPath: string): Promise<void> => {
            if (!this.isProcessing && (this.fileProcessor.shouldEncryptPath(newPath) || this.fileProcessor.shouldEncryptPath(path))) {
                await blockIfLocked(newPath, "copy to");
                const data = await adapter.readBinary(path);
                return adapter.writeBinary(newPath, data);
            }
            return (this.app.vault.adapter as any).copy.call(adapter, path, newPath);
        };
    }

    private isEncrypted(buffer: ArrayBuffer): boolean {
        const sig = this.vaultManager.signature;
        if (!sig || buffer.byteLength < sig.length) return false;
        
        const data = new Uint8Array(buffer);
        for (let i = 0; i < sig.length; i++) {
            if (data[i] !== sig[i]) return false;
        }
        return true;
    }

    private async getCachedDecryption(path: string, encryptedData: ArrayBuffer): Promise<{ data: Uint8Array, mask: Uint8Array }> {
        const key = path + ":" + encryptedData.byteLength;
        if (this.decryptionCache.has(key)) {
            return this.decryptionCache.get(key)!;
        }

        const sig = this.vaultManager.signature;
        const ciphertext = new Uint8Array(encryptedData).slice(sig.length);
        
        const promise = (async () => {
            const plaintext = await this.vaultManager.decrypt(ciphertext);
            const mask = new Uint8Array(32);
            crypto.getRandomValues(mask);
            
            // Mask the data before storing
            this.maskData(plaintext, mask);
            
            return { data: plaintext, mask };
        })();

        this.decryptionCache.set(key, promise);
        
        setTimeout(() => {
            const cached = this.decryptionCache.get(key);
            if (cached) {
                cached.then(c => {
                    c.data.fill(0);
                    c.mask.fill(0);
                });
                this.decryptionCache.delete(key);
            }
        }, 5000); // Keep in cache for 5 seconds
        
        return promise;
    }

    private maskData(data: Uint8Array, mask: Uint8Array) {
        if (mask.length === 0) return;
        for (let i = 0; i < data.length; i++) {
            data[i] ^= mask[i % mask.length];
        }
    }

    private setupImageObserver() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLElement) {
                        const images = node.querySelectorAll('img');
                        images.forEach(img => this.handleImageElement(img as HTMLImageElement));
                        
                        const bgElements = node.querySelectorAll('[style*="background-image"]');
                        bgElements.forEach(el => this.handleBgImageElement(el as HTMLElement));

                        if (node instanceof HTMLImageElement) {
                            this.handleImageElement(node);
                        }
                        if (node.style && node.style.backgroundImage) {
                            this.handleBgImageElement(node);
                        }
                    }
                });
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
    }

    private async handleImageElement(img: HTMLImageElement) {
        let src = img.getAttribute('src');
        if (!src || src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('http')) return;

        const file = this.resolveFileFromSrc(src, img.getAttribute('data-path'));
        if (file instanceof TFile && this.isImage(file)) {
            // Check if already in cache (instant) or needs lazy loading
            if (this.imageProcessor.hasCached(file.path)) {
                const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
                if (blobUrl) img.src = blobUrl;
                return;
            }

            // Otherwise, observe for lazy decryption
            img.classList.add('uwu-lazy-image');
            this.lazyImageObserver.observe(img);
        }
    }

    private async handleBgImageElement(el: HTMLElement) {
        const bg = el.style.backgroundImage;
        if (!bg || !bg.includes('url(')) return;
        if (bg.includes('blob:') || bg.includes('data:')) return;

        const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
        if (!match) return;
        const src = match[1];

        const file = this.resolveFileFromSrc(src, el.getAttribute('data-path'));
        if (file instanceof TFile && this.isImage(file)) {
             if (this.imageProcessor.hasCached(file.path)) {
                const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
                if (blobUrl) el.style.backgroundImage = `url("${blobUrl}")`;
                return;
            }
            
            this.lazyImageObserver.observe(el);
        }
    }

    private setupLazyImageObserver() {
        this.lazyImageObserver = new IntersectionObserver((entries) => {
            entries.forEach(async (entry) => {
                if (entry.isIntersecting) {
                    const el = entry.target as HTMLElement;
                    this.lazyImageObserver.unobserve(el);
                    
                    if (el instanceof HTMLImageElement) {
                        const src = el.getAttribute('src');
                        if (!src) return;
                        const file = this.resolveFileFromSrc(src, el.getAttribute('data-path'));
                        if (file instanceof TFile) {
                            const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
                            if (blobUrl) {
                                el.src = blobUrl;
                                el.setAttribute('data-uwu-decrypted', 'true');
                                el.style.opacity = '0';
                                requestAnimationFrame(() => {
                                    el.style.transition = 'opacity 0.3s ease-in-out';
                                    el.style.opacity = '1';
                                });
                            }
                        }
                    } else {
                        const bg = el.style.backgroundImage;
                        const match = bg.match(/url\(['"]?(.*?)['"]?\)/);
                        if (!match) return;
                        const file = this.resolveFileFromSrc(match[1], el.getAttribute('data-path'));
                        if (file instanceof TFile) {
                            const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
                            if (blobUrl) {
                                el.style.backgroundImage = `url("${blobUrl}")`;
                                el.setAttribute('data-uwu-decrypted', 'true');
                            }
                        }
                    }
                }
            });
        }, { rootMargin: '200px' }); // Decrypt slightly before it enters the viewport
    }

    private resolveFileFromSrc(src: string, dataPath: string | null): TFile | null {
        if (dataPath) {
            const file = this.app.vault.getAbstractFileByPath(dataPath);
            if (file instanceof TFile) return file;
        }

        const cleanSrc = decodeURIComponent(src.split('?')[0]);
        
        // Strategy 1: app:// prefix stripping
        if (cleanSrc.startsWith('app://')) {
            const vaultRootResource = this.app.vault.adapter.getResourcePath('');
            const prefix = vaultRootResource.split('?')[0];
            if (cleanSrc.toLowerCase().startsWith(prefix.toLowerCase())) {
                const vaultPath = cleanSrc.substring(prefix.length);
                const file = this.app.vault.getAbstractFileByPath(vaultPath);
                if (file instanceof TFile) return file;
            }
            
            // Fallback: search for the filename in the whole vault if it's app:// but prefix didn't match
            const fileName = cleanSrc.split('/').pop() || '';
            const file = this.app.metadataCache.getFirstLinkpathDest(fileName, '');
            if (file instanceof TFile) return file;
        }

        // Strategy 2: Direct resolution (for relative paths)
        const file = this.app.metadataCache.getFirstLinkpathDest(cleanSrc, '');
        if (file instanceof TFile) return file;

        // Final fallback: try to find by name from any path
        const fileName = cleanSrc.split('/').pop() || '';
        const fallbackFile = this.app.metadataCache.getFirstLinkpathDest(fileName, '');
        if (fallbackFile instanceof TFile) return fallbackFile;

        return null;
    }

    private activateUwuView(file: TFile) {
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() !== UWU_VIEW_TYPE && (leaf.view as any).file === file) {
                leaf.setViewState({
                    type: UWU_VIEW_TYPE,
                    state: { file: file.path },
                });
            }
        });
    }

    private isImage(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        // 1. Try Obsidian's official view registry
        const type = (this.app as any).viewRegistry?.getTypeByExtension(ext);
        if (type === 'image') return true;

        // 2. Comprehensive fallback list for standard image formats
        const imageExtensions = [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif',
            'ico', 'jfif', 'pjpeg', 'pjp', 'avif', 'heic', 'heif', 'jxl'
        ];
        return imageExtensions.includes(ext);
    }

    async onunload() {
        this.imageProcessor.clearCache();
        const adapter = this.app.vault.adapter;
        if (this.originalAdapterRead) adapter.read = this.originalAdapterRead;
        if (this.originalAdapterReadBinary) adapter.readBinary = this.originalAdapterReadBinary;
        if (this.originalAdapterWrite) adapter.write = this.originalAdapterWrite;
        if (this.originalAdapterWriteBinary) (adapter as any).writeBinary = this.originalAdapterWriteBinary;
        if (this.originalAdapterProcess) adapter.process = this.originalAdapterProcess;
        if (this.originalAdapterMkdir) adapter.mkdir = this.originalAdapterMkdir;
        if (this.originalAdapterRemove) adapter.remove = this.originalAdapterRemove;
        if (this.originalAdapterTrashLocal) adapter.trashLocal = this.originalAdapterTrashLocal;
        if (this.originalAdapterTrashSystem) adapter.trashSystem = this.originalAdapterTrashSystem;
        if (this.originalAdapterRmdir) adapter.rmdir = this.originalAdapterRmdir;
        if (this.originalAdapterRename) adapter.rename = this.originalAdapterRename;

        if (this.originalSetViewState) {
            WorkspaceLeaf.prototype.setViewState = this.originalSetViewState;
        }

        if (this.lazyImageObserver) {
            this.lazyImageObserver.disconnect();
        }

        if (this.vaultManager) {
            this.vaultManager.destroy();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class UwuCryptSettingTab extends PluginSettingTab {
    plugin: UwuCryptPlugin;

    constructor(app: App, plugin: UwuCryptPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'UWU-Crypt Settings' });

        new Setting(containerEl)
            .setName('Remember password')
            .setDesc('Keep vault unlocked after first successful password entry.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.rememberPassword)
                .onChange(async (value) => {
                    this.plugin.settings.rememberPassword = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Session timeout (minutes)')
            .setDesc('Lock vault after N minutes of inactivity (0 to disable).')
            .addText(text => text
                .setValue(this.plugin.settings.sessionTimeout.toString())
                .onChange(async (value) => {
                    this.plugin.settings.sessionTimeout = parseInt(value) || 0;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('ZSTD Compression Level')
            .setDesc('Compression level (1-22). Higher is better but slower. Default: 8.')
            .addSlider(slider => slider
                .setLimits(1, 22, 1)
                .setValue(this.plugin.settings.zstdLevel)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.zstdLevel = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Encrypt all files')
            .setDesc('Automatically encrypt every file created or modified in the vault.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.encryptAll)
                .onChange(async (value) => {
                    this.plugin.settings.encryptAll = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Encrypted folders')
            .setDesc('List of folders to encrypt automatically (recursive, one per line). Only used if "Encrypt all files" is off.')
            .addTextArea(text => text
                .setPlaceholder('Folder/Path\nAnother/Folder')
                .setValue(this.plugin.settings.encryptedFolders.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.encryptedFolders = value.split('\n').map(s => s.trim()).filter(s => s.length > 0);
                    await this.plugin.saveSettings();
                }));
    }
}
