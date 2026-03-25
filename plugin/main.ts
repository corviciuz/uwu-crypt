import { Plugin, PluginSettingTab, App, Setting, TFile, TFolder, Menu, Notice, WorkspaceLeaf, TAbstractFile, DataWriteOptions } from 'obsidian';
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
    sessionTimeout: 10,
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

        this.addRibbonIcon('lock', 'Encrypt all vault', () => {
             this.fileProcessor.processAllVault(true);
        });

        this.addRibbonIcon('unlock', 'Decrypt all vault', () => {
             this.fileProcessor.processAllVault(false);
        });

        this.addCommand({
            id: 'unlock-vault',
            name: 'Unlock Vault',
            callback: () => {
                this.vaultManager.requestUnlock();
            }
        });

        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                if (!(file instanceof TFile)) return;
                
                const buffer = await this.originalAdapterReadBinary.call(this.app.vault.adapter, file.path);
                if (this.isEncrypted(buffer) && !this.vaultManager.unlocked()) {
                    this.activateUwuView(file);
                    try {
                        await this.vaultManager.requestUnlock();
                    } catch {}
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item.setTitle('Encrypt File')
                            .setIcon('lock')
                            .onClick(() => this.fileProcessor.processFile(file, true));
                    });
                    menu.addItem((item) => {
                        item.setTitle('Decrypt File')
                            .setIcon('unlock')
                            .onClick(() => this.fileProcessor.processFile(file, false));
                    });
                } else if (file instanceof TFolder) {
                    menu.addItem((item) => {
                        item.setTitle('Encrypt Folder Recursively')
                            .setIcon('lock')
                            .onClick(() => this.fileProcessor.processFolder(file, true));
                    });
                    menu.addItem((item) => {
                        item.setTitle('Decrypt Folder Recursively')
                            .setIcon('unlock')
                            .onClick(() => this.fileProcessor.processFolder(file, false));
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
                    if (file) {
                        leaf.setViewState({
                            type: 'markdown',
                            state: leaf.view.getState(),
                            popstate: true
                        } as any);
                    }
                }
            });
            new Notice('UWU Crypt: Vault Unlocked');
        }));

        this.registerEvent(this.app.workspace.on('uwu-crypt:lock' as any, () => {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view.getViewType() === 'markdown') {
                    const file = (leaf.view as any).file;
                    if (file instanceof TFile) {
                        this.originalAdapterReadBinary.call(this.app.vault.adapter, file.path).then((buffer: ArrayBuffer) => {
                            if (this.isEncrypted(buffer)) {
                                this.activateUwuView(file);
                            }
                        });
                    }
                }
            });
            new Notice('UWU Crypt: Vault Locked');
            this.imageProcessor.clearCache();
        }));

        // Initial Setup Modal Check
        this.app.workspace.onLayoutReady(async () => {
            const hasConfig = this.app.vault.getAbstractFileByPath('.uwu/config.json') || this.settings.manifestBackup;
            if (!hasConfig) {
                this.vaultManager.requestUnlock(true);
            } else {
                // Mandatory password on startup
                this.vaultManager.requestUnlock(false);
            }
        });
    }

    private setupHooks() {
        const adapter = this.app.vault.adapter;
        
        this.originalAdapterRead = adapter.read;
        this.originalAdapterReadBinary = adapter.readBinary;
        this.originalAdapterWrite = adapter.write;
        this.originalAdapterWriteBinary = (adapter as any).writeBinary; // Ensure we get writeBinary
        this.originalAdapterProcess = adapter.process;

        adapter.read = async (path: string): Promise<string> => {
            try {
                const buffer = await this.originalAdapterReadBinary.call(adapter, path);
                if (!this.isProcessing && this.isEncrypted(buffer)) {
                    if (!this.vaultManager.unlocked()) {
                        await this.vaultManager.requestUnlock();
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
                await this.vaultManager.requestUnlock();
            }
            const { data, mask } = await this.getCachedDecryption(path, buffer);
            // Unmask on the fly
            const unmasked = new Uint8Array(data);
            this.maskData(unmasked, mask);
            
            const result = unmasked.buffer.slice(unmasked.byteOffset, unmasked.byteOffset + unmasked.byteLength) as ArrayBuffer;
            unmasked.fill(0); // Clear sensitive data
            return result;
        }
        return buffer;
    };

        adapter.write = async (path: string, data: string, options?: DataWriteOptions): Promise<void> => {
            if (!this.isProcessing && this.fileProcessor.shouldEncryptPath(path)) {
                if (!this.vaultManager.unlocked()) {
                    await this.vaultManager.requestUnlock();
                }
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
                if (!this.vaultManager.unlocked()) {
                    await this.vaultManager.requestUnlock();
                }
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
            const content = await adapter.read(path);
            const result = fn(content);
            await adapter.write(path, result, options);
            return result;
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
            const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
            if (blobUrl) {
                img.src = blobUrl;
                img.setAttribute('data-uwu-decrypted', 'true');
            }
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
            const blobUrl = await this.imageProcessor.getDecryptedBlobUrl(file);
            if (blobUrl) {
                el.style.backgroundImage = `url("${blobUrl}")`;
                el.setAttribute('data-uwu-decrypted', 'true');
            }
        }
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
        return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(file.extension.toLowerCase());
    }

    async onunload() {
        this.imageProcessor.clearCache();
        const adapter = this.app.vault.adapter;
        if (this.originalAdapterRead) adapter.read = this.originalAdapterRead;
        if (this.originalAdapterReadBinary) adapter.readBinary = this.originalAdapterReadBinary;
        if (this.originalAdapterWrite) adapter.write = this.originalAdapterWrite;
        if (this.originalAdapterWriteBinary) (adapter as any).writeBinary = this.originalAdapterWriteBinary;
        if (this.originalAdapterProcess) adapter.process = this.originalAdapterProcess;

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
        containerEl.createEl('h2', { text: 'UWU Crypt Settings' });

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
