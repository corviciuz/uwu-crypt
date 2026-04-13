import { Plugin, PluginSettingTab, App, Setting, TFile, TFolder, Menu, Notice, WorkspaceLeaf, TAbstractFile, DataWriteOptions, setIcon, debounce, normalizePath } from 'obsidian';
import { VaultManager } from './vaultManager.ts';
import { FileProcessor } from './fileProcessor.ts';
import { UwuView, UWU_VIEW_TYPE } from './uwuView.ts';
import { SetupModal } from './setupModal.ts';
import { ResourceProcessor } from './resourceProcessor.ts';

interface UwuCryptSettings {
    rememberPassword: boolean;
    sessionTimeout: number; // in minutes
    zstdLevel: number;
    encryptAll: boolean;
    encryptedFolders: string[];
    showIndicators: boolean;
    manifestBackup: string | null;
    panicLock: boolean;
}

const DEFAULT_SETTINGS: UwuCryptSettings = {
    rememberPassword: true,
    sessionTimeout: 20,
    zstdLevel: 8,
    encryptAll: false,
    encryptedFolders: [],
    showIndicators: true,
    manifestBackup: null,
    panicLock: true
};

export default class UwuCryptPlugin extends Plugin {
    settings!: UwuCryptSettings;
    vaultManager!: VaultManager;
    fileProcessor!: FileProcessor;
    resourceProcessor!: ResourceProcessor;
    // processingPaths удалён — используется fileProcessor.isProcessing()

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
    private originalAdapterGetResourcePath!: any;
    private _patchedRead!: any;
    private _patchedReadBinary!: any;
    private _patchedWrite!: any;
    private ribbonIconEl!: HTMLElement;
    private lazyResourceObserver!: IntersectionObserver;
    private encryptedPaths: Set<string> = new Set();
    private explorerObserver!: MutationObserver;
    private originalSetViewState!: any;
    private isUpdatingRibbon = false;
    private monkeyPatchActive = false;

    private decryptionCache = new Map<string, Promise<{ data: Uint8Array, nonce: Uint8Array }>>();
    private decryptionTimers = new Map<string, number>(); // path -> timer id

    async onload() {
        await this.loadSettings();

        this.vaultManager = new VaultManager(this);
        // Ensure crypto worker is ready before registering hooks
        try {
            await Promise.race([
                (this.vaultManager as any).readyPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Crypto worker timeout')), 15000))
            ]);
        } catch (e: any) {
            console.error('UWU-Crypt: Worker initialization failed:', e);
            new Notice('(⊙ˍ⊙) UWU-Crypt: Failed to load crypto worker. Plugin disabled.');
            return;
        }
        
        this.fileProcessor = new FileProcessor(this, this.vaultManager, this.settings);
        this.resourceProcessor = new ResourceProcessor(this, this.vaultManager, this.getSignatureLength.bind(this));

        this.ribbonIconEl = this.addRibbonIcon('unlock', 'Unlock Vault', async () => {
            if (this.vaultManager.unlocked()) {
                this.vaultManager.lockVault();
            } else {
                const hasConfig = (await this.app.vault.adapter.exists('.uwu/vault.uwu')) || this.settings.manifestBackup;
                this.vaultManager.requestUnlock(!hasConfig).catch(() => {});
            }
        });
        this.ribbonIconEl.addClass('uwu-ribbon-icon');

        this.registerView(
            UWU_VIEW_TYPE,
            (leaf) => new UwuView(leaf, this.vaultManager)
        );

        // Hook DataAdapter for transparent encryption/decryption
        this.setupHooks();
        // ResourceProcessor needs original adapter to bypass decryption hook
        this.resourceProcessor.originalReadBinary = this.originalAdapterReadBinary.bind(this.app.vault.adapter);
        
        if (this.settings.showIndicators) {
            this.setupFileExplorerObserver();
            this.scanVaultForEncryptedFiles();
        }

        // Resource rendering support (Images, Audio, Video, PDF)
        this.registerMarkdownPostProcessor((el, ctx) => {
            // Images
            el.querySelectorAll('img').forEach(async (img) => {
                const src = img.getAttribute('src');
                if (src && (src.startsWith('app://') || src.startsWith('capacitor://') || !src.includes('://'))) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);
                    if (file instanceof TFile && (this.isImage(file) || file.extension.toLowerCase() === 'svg')) {
                        const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                        if (blobUrl) img.src = blobUrl;
                    }
                }
            });

            // Audio/Video/Source
            el.querySelectorAll('audio, video, source').forEach(async (media) => {
                const src = media.getAttribute('src');
                if (src) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);
                    if (file instanceof TFile) {
                        const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                        if (blobUrl) {
                            (media as any).src = blobUrl;
                            if ((media as any).load) setTimeout(() => (media as any).load(), 100);
                        }
                    }
                }
            });

            // PDF Embeds & iFrames
            el.querySelectorAll('embed, iframe').forEach(async (embed) => {
                const src = embed.getAttribute('src');
                if (src) {
                    const file = this.app.metadataCache.getFirstLinkpathDest(src, ctx.sourcePath);
                    if (file instanceof TFile && file.extension.toLowerCase() === 'pdf') {
                        const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                        if (blobUrl) embed.setAttribute('src', blobUrl);
                    }
                }
            });
        });

        this.setupResourceObserver();
        this.setupLazyResourceObserver();

        this.app.workspace.onLayoutReady(() => {
            this.app.workspace.iterateAllLeaves((leaf) => {
                const file = (leaf.view as any).file;
                if (file instanceof TFile && (this.encryptedPaths.has(file.path) || this.fileProcessor.shouldEncryptPath(file.path))) {
                    if (this.vaultManager.unlocked()) {
                        // Force a reload once plugin hooks are active
                        try { (leaf.view as any).onLoadFile?.(file); } catch (e) { leaf.view.load(); }
                    } else {
                        UwuView.applyToLeaf(leaf, file);
                    }
                }
            });
            this.updateRibbon();
        });

        // Watch for mobile sidebar/drawer events to re-apply the correct icon/label
        this.registerEvent(this.app.workspace.on('layout-change', () => this.updateRibbon()));
        
        const debouncedUpdate = debounce(() => this.updateRibbon(), 200, true);
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    debouncedUpdate();
                    break;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        this.register(() => observer.disconnect());

        this.registerEvent(this.app.workspace.on('uwu-crypt:lock' as any, () => this.updateRibbon()));
        this.registerEvent(this.app.workspace.on('uwu-crypt:unlock' as any, () => this.updateRibbon()));
        this.updateRibbon();

        this.addCommand({
            id: 'lock-unlock-vault',
            name: 'Unlock Vault',
            callback: async () => {
                const unlocked = this.vaultManager.unlocked();
                if (unlocked) {
                    this.vaultManager.lockVault();
                } else {
                    const hasConfig = (await this.app.vault.adapter.exists('.uwu/vault.uwu')) || this.settings.manifestBackup;
                    this.vaultManager.requestUnlock(!hasConfig).catch(() => {});
                }
            }
        });

        this.addCommand({
            id: 'emergency-disable-auto-encrypt',
            name: 'Emergency: Disable Auto-Encrypt',
            callback: () => {
                this.monkeyPatchActive = false;
                new Notice('(⌐■_■) Auto-encrypt DISABLED. Files will be written as plaintext.');
            }
        });

        this.registerEvent(this.app.workspace.on('file-open', async (file) => {
            if (file instanceof TFile && this.vaultManager.unlocked()) {
                const ext = file.extension.toLowerCase();
                const isMedia = ['pdf', 'mp3', 'wav', 'flac', 'm4a', 'ogg', '3gp', 'mp4', 'webm', 'ogv', 'mov', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext);
                
                // Case 1: Media file itself
                if (isMedia && (this.encryptedPaths.has(file.path) || this.fileProcessor.shouldEncryptPath(file.path))) {
                    const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                    if (blobUrl) {
                        this.app.workspace.iterateAllLeaves(leaf => {
                            if ((leaf.view as any).file === file) {
                                try { (leaf.view as any).onLoadFile?.(file); } catch (e) { leaf.view.load(); }
                            }
                        });
                    }
                }

                // Case 2: Pre-decrypt all media links in MD notes
                if (ext === 'md') {
                    const cache = this.app.metadataCache.getFileCache(file);
                    if (cache?.embeds) {
                        for (const embed of cache.embeds) {
                            const target = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
                            if (target instanceof TFile) {
                                const targetExt = target.extension.toLowerCase();
                                const isTargetMedia = ['pdf', 'mp3', 'wav', 'flac', 'm4a', 'ogg', '3gp', 'mp4', 'webm', 'ogv', 'mov', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(targetExt);
                                if (isTargetMedia && (this.encryptedPaths.has(target.path) || this.fileProcessor.shouldEncryptPath(target.path))) {
                                    await this.resourceProcessor.getDecryptedBlobUrl(target);
                                }
                            }
                        }
                    }
                }
            }
        }));

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

        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile) this.refreshFileStatus(file);
        }));

        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile) this.refreshFileStatus(file);
        }));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            this.encryptedPaths.delete(file.path);
            this.updateFileExplorerIndicators();
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (this.encryptedPaths.has(oldPath)) {
                this.encryptedPaths.delete(oldPath);
                this.encryptedPaths.add(file.path);
            }
            this.updateFileExplorerIndicators();
        }));

        this.registerEvent(this.app.workspace.on('layout-change', () => {
            this.updateFileExplorerIndicators();
        }));

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item.setTitle('Checking encryption state...')
                            .setIcon('loader')
                            .setDisabled(true);
                        
                        (async () => {
                            try {
                                const buffer = await this.originalAdapterReadBinary.call(this.app.vault.adapter, file.path);
                                const isEnc = this.isEncrypted(buffer);
                                item.setDisabled(false);
                                if (isEnc) {
                                    item.setTitle('Decrypt File')
                                        .setIcon('unlock')
                                        .onClick(async () => {
                                            await this.fileProcessor.processFile(file, false);
                                            new Notice(`( •_•)>⌐■-■ Decrypted file ${file.name}`);
                                        });
                                } else {
                                    item.setTitle('Encrypt File')
                                        .setIcon('lock')
                                        .onClick(async () => {
                                            await this.fileProcessor.processFile(file, true);
                                            new Notice(`(⌐■_■) Encrypted file ${file.name}`);
                                        });
                                }
                            } catch (e) {
                                item.setTitle('UWU Crypt Error').setDisabled(true);
                            }
                        })();
                    });
                } else if (file instanceof TFolder) {
                    // ... folder items stay same ...
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
            this.app.workspace.iterateAllLeaves(async (leaf) => {
                const file = (leaf.view as any).file;
                if (file instanceof TFile && (this.encryptedPaths.has(file.path) || leaf.view.getViewType() === UWU_VIEW_TYPE)) {
                    // Pre-populate resource cache
                    if (['pdf', 'mp3', 'wav', 'mp4'].includes(file.extension.toLowerCase())) {
                        await this.resourceProcessor.getDecryptedBlobUrl(file);
                    }

                    const state = leaf.getViewState();
                    if (leaf.view.getViewType() === UWU_VIEW_TYPE) {
                        const viewType = (this.app as any).viewRegistry?.getTypeByExtension(file.extension) || 'markdown';
                        leaf.setViewState({
                            type: viewType,
                            state: leaf.view.getState(),
                            popstate: true
                        } as any);
                    } else {
                        // Direct onLoadFile — no empty swap hack
                        try { (leaf.view as any).onLoadFile?.(file); } catch (e) { leaf.view.load(); }
                    }
                }
            });
            new Notice('(*￣︶￣)/ Vault Unlocked');
        }));

        this.registerEvent(this.app.workspace.on('uwu-crypt:lock' as any, () => {
            // 1. Синхронная очистка decryption cache + таймеры
            for (const [key, timerId] of this.decryptionTimers) {
                clearTimeout(timerId);
            }
            this.decryptionTimers.clear();

            const entries = Array.from(this.decryptionCache.values());
            for (const promise of entries) {
                promise.then(({ data, nonce }) => {
                    try { if (data.buffer.byteLength > 0) data.fill(0); } catch {}
                    try { if (nonce.buffer.byteLength > 0) nonce.fill(0); } catch {}
                }).catch(() => {});
            }
            this.decryptionCache.clear();

            // 2. Refresh views (Switch ALL relevant leaves to UwuView/Locked state)
            this.app.workspace.iterateAllLeaves((leaf) => {
                const file = (leaf.view as any).file;
                if (file instanceof TFile && (this.encryptedPaths.has(file.path) || this.fileProcessor.shouldEncryptPath(file.path))) {
                    UwuView.applyToLeaf(leaf, file);
                }
            });
            new Notice('(・∀・)ノ Vault Locked');
            this.resourceProcessor.clearCache();
            // processingPaths больше не используется
        }));

        // Initial Setup Modal Check (only if no vault exists)
        this.app.workspace.onLayoutReady(async () => {
            const hasConfig = (await this.app.vault.adapter.exists('.uwu/vault.uwu')) || this.settings.manifestBackup;
            if (!hasConfig) {
                this.vaultManager.requestUnlock(true).catch(() => {});
            }
        });
    }

    private updateRibbon() {
        if (this.isUpdatingRibbon) return;
        this.isUpdatingRibbon = true;

        const unlocked = this.vaultManager.unlocked();
        const icon = unlocked ? 'lock' : 'unlock';
        const label = unlocked ? 'Lock Vault' : 'Unlock Vault';

        // Find all possible instances of the ribbon button (including mobile sidebar clones)
        const selectors = [
            '.uwu-ribbon-icon',
            '.side-dock-ribbon-action[aria-label*="Vault"]',
            '.side-dock-ribbon-action[data-tooltip*="Vault"]'
        ];

        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach((node: Element) => {
                const el = node as HTMLElement;
                // Double check it's likely our icon by class or by label pattern
                if (el.hasClass('uwu-ribbon-icon') || 
                    el.getAttribute('aria-label')?.includes('Vault') || 
                    el.getAttribute('data-tooltip')?.includes('Vault')) {
                    
                    const iconContainer = el.querySelector('.side-dock-ribbon-action-icon') || el;
                    setIcon(iconContainer as HTMLElement, icon);
                    el.setAttr('aria-label', label);
                    el.setAttr('title', label);
                    el.addClass('uwu-ribbon-icon'); // Mark clones for future updates

                    const textEl = el.querySelector('.side-dock-ribbon-action-text');
                    if (textEl) textEl.textContent = label;
                }
            });
        });

        this.updateCommandName();
        this.isUpdatingRibbon = false;
    }

    private updateCommandName() {
        const unlocked = this.vaultManager.unlocked();
        const commandId = `${this.manifest.id}:lock-unlock-vault`;
        // @ts-ignore
        const command = this.app.commands.commands[commandId];
        if (command) {
            command.name = unlocked ? 'Lock Vault' : 'Unlock Vault';
        }
    }

    private setupLeafHooks() {
        const self = this;
        this.originalSetViewState = WorkspaceLeaf.prototype.setViewState;
        
        WorkspaceLeaf.prototype.setViewState = function(viewState: any, result?: any) {
            if (!self.vaultManager.unlocked()) {
                const filePath = viewState.state?.file || viewState.state?.path;
                if (filePath && typeof filePath === 'string') {
                    // Check if the current target is an encrypted file or in an encrypted folder
                    const isKnownEncrypted = self.encryptedPaths.has(filePath);
                    const shouldBeEncrypted = self.fileProcessor.shouldEncryptPath(filePath);
                    
                    if (viewState.type !== UWU_VIEW_TYPE && (isKnownEncrypted || shouldBeEncrypted)) {
                        viewState.type = UWU_VIEW_TYPE;
                        viewState.state = { file: filePath };
                    }
                }
            }
            return self.originalSetViewState.call(this, viewState, result);
        };

        const originalOpenFile = WorkspaceLeaf.prototype.openFile;
        WorkspaceLeaf.prototype.openFile = async function(file: TFile, state?: any) {
            if (file instanceof TFile && self.vaultManager.unlocked()) {
                const ext = file.extension.toLowerCase();
                const isMedia = ['pdf', 'mp3', 'wav', 'flac', 'm4a', 'ogg', '3gp', 'mp4', 'webm', 'ogv', 'mov', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext);
                if (isMedia && (self.encryptedPaths.has(file.path) || self.fileProcessor.shouldEncryptPath(file.path))) {
                    // Pre-decrypt and wait so getResourcePath hook always finds it in cache
                    await self.resourceProcessor.getDecryptedBlobUrl(file);
                }
            }
            return originalOpenFile.call(this, file, state);
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
            if (!this.fileProcessor.isProcessing(path) && (this.fileProcessor.shouldEncryptPath(path) || this.encryptedPaths.has(path)) && !this.vaultManager.unlocked()) {
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
            this.assertPatchIntegrity();
            try {
                await (this.vaultManager as any).readyPromise;
                const buffer = await this.originalAdapterReadBinary.call(adapter, path);
                const sigLen = this.getSignatureLength(buffer);
                if (!this.fileProcessor.isProcessing(path) && sigLen > 0) {
                    if (!this.vaultManager.unlocked()) {
                        return "%% (⊙ˍ⊙) File is locked. Please unlock the vault to view this content. %%";
                    }

                    const ciphertext = new Uint8Array(buffer).slice(sigLen);
                    const plaintext = await this.vaultManager.decrypt(ciphertext);

                    const text = new TextDecoder().decode(plaintext);
                    plaintext.fill(0);
                    return text;
                }
            } catch (e) {
                console.error(`(⊙ˍ⊙) Decryption error for ${path}:`, e);
            }
            return this.originalAdapterRead.call(adapter, path);
        };

        adapter.readBinary = async (path: string): Promise<ArrayBuffer> => {
            this.assertPatchIntegrity();
            await (this.vaultManager as any).readyPromise;
            const buffer = await this.originalAdapterReadBinary.call(adapter, path);
            const sigLen = this.getSignatureLength(buffer);
            if (!this.fileProcessor.isProcessing(path) && sigLen > 0) {
                if (!this.vaultManager.unlocked()) {
                    return buffer; // Return encrypted data if locked
                }
                const cached = await this.getCachedDecryption(path, buffer);
                const unmasked = await this.unmaskData(new Uint8Array(cached.data), cached.nonce);
                const result = unmasked.buffer.slice(unmasked.byteOffset, unmasked.byteOffset + unmasked.byteLength) as ArrayBuffer;
                unmasked.fill(0);
                return result;
            }
            return buffer;
        };

        adapter.write = async (path: string, data: string, options?: DataWriteOptions): Promise<void> => {
            this.assertPatchIntegrity();
            const shouldEncrypt = this.fileProcessor.shouldEncryptPath(path) || this.encryptedPaths.has(path);
            if (!this.fileProcessor.isProcessing(path) && shouldEncrypt && this.monkeyPatchActive) {
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
            this.assertPatchIntegrity();
            const shouldEncrypt = this.fileProcessor.shouldEncryptPath(path) || this.encryptedPaths.has(path);
            if (!this.fileProcessor.isProcessing(path) && shouldEncrypt && this.monkeyPatchActive) {
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
            this.assertPatchIntegrity();
            await (this.vaultManager as any).readyPromise;
            if (!this.fileProcessor.isProcessing(path) && (this.fileProcessor.shouldEncryptPath(path) || this.isEncrypted(await this.originalAdapterReadBinary.call(adapter, path)))) {
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
            this.assertPatchIntegrity();
            await (this.vaultManager as any).readyPromise;
            if (!this.fileProcessor.isProcessing(path) && (this.fileProcessor.shouldEncryptPath(path) || this.isEncrypted(await this.originalAdapterReadBinary.call(adapter, path)))) {
                await blockIfLocked(path, "append to");
                // Decrypt → decode → append string → re-encrypt
                const content = await adapter.read(path);
                return adapter.write(path, content + data, options);
            }
            return (this.app.vault.adapter as any).append.call(adapter, path, data, options);
        };

        (adapter as any).appendBinary = async (path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> => {
            this.assertPatchIntegrity();
            await (this.vaultManager as any).readyPromise;
            if (!this.fileProcessor.isProcessing(path) && (this.fileProcessor.shouldEncryptPath(path) || this.isEncrypted(await this.originalAdapterReadBinary.call(adapter, path)))) {
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
            this.assertPatchIntegrity();
            if (!this.fileProcessor.isProcessing(path) && (this.fileProcessor.shouldEncryptPath(newPath) || this.fileProcessor.shouldEncryptPath(path))) {
                await blockIfLocked(newPath, "copy to");
                const data = await adapter.readBinary(path);
                return adapter.writeBinary(newPath, data);
            }
            return (this.app.vault.adapter as any).copy.call(adapter, path, newPath);
        };

        this.originalAdapterGetResourcePath = adapter.getResourcePath;
        adapter.getResourcePath = (path: string) => {
            const tFile = this.app.vault.getAbstractFileByPath(path);
            if (tFile instanceof TFile && this.vaultManager.unlocked() && this.resourceProcessor.hasCached(tFile.path)) {
                return this.resourceProcessor.getCachedBlobUrl(tFile.path) || this.originalAdapterGetResourcePath.call(adapter, path);
            }
            return this.originalAdapterGetResourcePath.call(adapter, path);
        };

        // Store references to our patched functions for integrity checks
        this._patchedRead = adapter.read;
        this._patchedReadBinary = adapter.readBinary;
        this._patchedWrite = adapter.write;

        // Проверка целостности monkey-patch
        this.monkeyPatchActive = (
            adapter.read !== this.originalAdapterRead &&
            adapter.readBinary !== this.originalAdapterReadBinary &&
            adapter.write !== this.originalAdapterWrite &&
            (adapter as any).writeBinary !== this.originalAdapterWriteBinary
        );

        if (!this.monkeyPatchActive) {
            throw new Error('(⊙ˍ⊙) UWU-Crypt: Monkey-patch failed! Filesystem interception is not active. Plugin disabled to prevent plaintext leaks.');
        }
    }

    private assertPatchIntegrity() {
        if (this.app.vault.adapter.read !== this._patchedRead ||
            this.app.vault.adapter.readBinary !== this._patchedReadBinary ||
            this.app.vault.adapter.write !== this._patchedWrite) {
            this.monkeyPatchActive = false;
            throw new Error('(⊙ˍ⊙) UWU-Crypt: Monkey-patch integrity compromised! Another plugin has overwritten our hooks.');
        }
    }

    private isEncrypted(buffer: ArrayBufferLike): boolean {
        const data = new Uint8Array(buffer);
        const sig = this.vaultManager.signature;
        
        // 1. Check current signature (most likely)
        if (sig && sig.length > 0 && buffer.byteLength >= sig.length) {
            let match = true;
            for (let i = 0; i < sig.length; i++) {
                if (data[i] !== sig[i]) { match = false; break; }
            }
            if (match) return true;
        }

        return false;
    }

    private getSignatureLength(buffer: ArrayBufferLike): number {
        const data = new Uint8Array(buffer);
        const sig = this.vaultManager.signature;
        
        if (sig && sig.length > 0 && buffer.byteLength >= sig.length) {
            let match = true;
            for (let i = 0; i < sig.length; i++) {
                if (data[i] !== sig[i]) { match = false; break; }
            }
            if (match) return sig.length;
        }

        return 0;
    }

    private async getCachedDecryption(path: string, encryptedData: ArrayBuffer): Promise<{ data: Uint8Array, nonce: Uint8Array }> {
        const key = path + ":" + encryptedData.byteLength;
        if (this.decryptionCache.has(key)) {
            return this.decryptionCache.get(key)!;
        }

        const sigLen = this.getSignatureLength(encryptedData);
        const ciphertext = new Uint8Array(encryptedData).slice(sigLen);

        const promise = (async () => {
            const plaintext = await this.vaultManager.decrypt(ciphertext);

            // ChaCha8 masking — 12-byte random nonce via WASM
            const nonce = new Uint8Array(12);
            crypto.getRandomValues(nonce);

            const masked = await this.maskData(plaintext, nonce);

            return { data: masked, nonce };
        })();

        this.decryptionCache.set(key, promise);

        // TTL 500ms — minimize plaintext residence in JS heap
        const prevTimer = this.decryptionTimers.get(key);
        if (prevTimer) clearTimeout(prevTimer);

        const timerId = window.setTimeout(() => {
            const cached = this.decryptionCache.get(key);
            if (cached) {
                cached.then(c => {
                    c.data.fill(0);
                    c.nonce.fill(0);
                }).catch(() => {});
            }
            this.decryptionCache.delete(key);
            this.decryptionTimers.delete(key);
        }, 500);

        this.decryptionTimers.set(key, timerId);

        return promise;
    }

    private invalidateDecryptionCache(path: string) {
        const keysToDelete: string[] = [];
        for (const key of this.decryptionCache.keys()) {
            if (key.startsWith(path + ":")) {
                keysToDelete.push(key);
            }
        }
        for (const key of keysToDelete) {
            const timerId = this.decryptionTimers.get(key);
            if (timerId) clearTimeout(timerId);
            this.decryptionTimers.delete(key);

            const cached = this.decryptionCache.get(key);
            if (cached) {
                cached.then(c => { c.data.fill(0); c.nonce.fill(0); }).catch(() => {});
            }
            this.decryptionCache.delete(key);
        }
    }

    // ChaCha8 masking via WASM — async, delegates to Rust core
    private async maskData(data: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
        if (nonce.length !== 4) return data;
        await (this.vaultManager as any).readyPromise;
        const result = await (this.vaultManager as any).sendMessage('MASK', { data, nonce });
        return result.data;
    }

    private async unmaskData(data: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
        if (nonce.length !== 4) return data;
        await (this.vaultManager as any).readyPromise;
        const result = await (this.vaultManager as any).sendMessage('UNMASK', { data, nonce });
        return result.data;
    }

    private setupResourceObserver() {
        const selectors = 'img, audio, video, embed, iframe, source';
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node instanceof HTMLElement) {
                            const elements = node.querySelectorAll(selectors);
                            elements.forEach(el => this.handleResourceElement(el as HTMLElement));
                            
                            const bgElements = node.querySelectorAll('[style*="background-image"]');
                            bgElements.forEach(el => this.handleBgImageElement(el as HTMLElement));

                            if (node.matches(selectors)) {
                                this.handleResourceElement(node);
                            }
                            if (node.style && node.style.backgroundImage) {
                                this.handleBgImageElement(node);
                            }
                        }
                    });
                } else if (mutation.type === 'attributes') {
                    const target = mutation.target as HTMLElement;
                    if (target.matches(selectors)) {
                        this.handleResourceElement(target);
                    }
                    if (target.style && target.style.backgroundImage) {
                        this.handleBgImageElement(target);
                    }
                }
            });
        });

        observer.observe(document.body, { 
            childList: true, 
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'style', 'data-path']
        });
        this.register(() => observer.disconnect());
    }

    private async getFileSignature(path: string): Promise<Uint8Array | null> {
        try {
            const sigLen = (this.vaultManager.signature as any)?.length || 16;
            const adapter = this.app.vault.adapter;

            // Optimization for Desktop: Use node:fs to read only the first few bytes
            if ((window as any).process && (window as any).process.versions.node) {
                try {
                    const fs = (window as any).require('fs');
                    const fullPath = (adapter as any).getFullPath(path);

                    return new Promise((resolve) => {
                        fs.open(fullPath, 'r', (err: any, fd: number) => {
                            if (err) return resolve(null);
                            const buffer = new Uint8Array(sigLen);
                            fs.read(fd, buffer, 0, sigLen, 0, (err: any) => {
                                fs.close(fd, () => {});
                                if (err) resolve(null);
                                else resolve(buffer);
                            });
                        });
                    });
                } catch {
                    // require('fs') failed — CSP restricted, fall through to DataAdapter
                }
            }

            // Fallback for Mobile: Read entire file (no range API in Obsidian DataAdapter unfortunately)
            // But we skip massive files to prevent OOM
            try {
                const stat = await adapter.stat(path);
                if (stat && stat.size > 10 * 1024 * 1024) { // > 10MB
                     return null;
                }

                const buffer = await this.originalAdapterReadBinary.call(adapter, path);
                return new Uint8Array(buffer.slice(0, sigLen));
            } catch {
                return null;
            }
        } catch (e) {
            return null;
        }
    }

    private async refreshFileStatus(file: TFile) {
        try {
            await (this.vaultManager as any).readyPromise;
            const wasEncrypted = this.encryptedPaths.has(file.path);
            const sig = await this.getFileSignature(file.path);
            const isEncrypted = sig ? this.isEncrypted(sig.buffer) : false;
            
            if (isEncrypted) this.encryptedPaths.add(file.path);
            else this.encryptedPaths.delete(file.path);

            // Always revoke old URL if file was modified
            this.resourceProcessor.revokeUrl(file.path);

            // Invalidate decryption cache for this file
            this.invalidateDecryptionCache(file.path);

            const ext = file.extension.toLowerCase();
            const isMedia = ['pdf', 'mp3', 'wav', 'flac', 'm4a', 'ogg', '3gp', 'mp4', 'webm', 'ogv', 'mov', 'mkv', 'opus'].includes(ext);

            // If encryption status changed OR it's a media file (we revoked its URL above), refresh views
            if (wasEncrypted !== isEncrypted || isMedia) {
                this.app.workspace.iterateAllLeaves(async (leaf) => {
                    if ((leaf.view as any).file === file) {
                        if (isEncrypted && !this.vaultManager.unlocked()) {
                            UwuView.applyToLeaf(leaf, file);
                        } else {
                            // Pre-decrypt for media files so getResourcePath hook finds it
                            if (isMedia && this.vaultManager.unlocked()) {
                                await this.resourceProcessor.getDecryptedBlobUrl(file);
                            }

                            // Forceful refresh for PDFs and other complex views — direct onLoadFile
                            if (ext === 'pdf' || leaf.view.getViewType() !== 'markdown') {
                                try { (leaf.view as any).onLoadFile?.(file); } catch (e) { leaf.view.load(); }
                            } else {
                                try { (leaf.view as any).onLoadFile?.(file); } catch (e) { leaf.view.load(); }
                            }
                        }
                    }
                });
            }
            
            this.updateFileExplorerIndicators();
        } catch (e) {
            // File might have been deleted or inaccessible
        }
    }

    private async scanVaultForEncryptedFiles() {
        await (this.vaultManager as any).readyPromise;
        const files = this.app.vault.getFiles();

        // Adaptive concurrency — max 5 for mobile safety
        const hwConcurrency = typeof navigator !== 'undefined' && (navigator as any).hardwareConcurrency;
        const concurrency = Math.min(5, hwConcurrency ? Math.max(1, hwConcurrency - 1) : 2);
        const queue = [...files];
        const processNext = async () => {
            while (queue.length > 0) {
                const file = queue.shift();
                if (!file) break;

                const sig = await this.getFileSignature(file.path);
                if (sig && this.isEncrypted(sig.buffer)) {
                    this.encryptedPaths.add(file.path);
                }

                // Yield occasionally
                if (queue.length % 50 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            }
        };

        await Promise.all(Array(concurrency).fill(0).map(processNext));
        this.updateFileExplorerIndicators();
    }

    private setupFileExplorerObserver() {
        this.explorerObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        if (node instanceof HTMLElement) {
                            if (node.hasClass('nav-file') || node.hasClass('nav-folder')) {
                                this.applyIndicator(node);
                            }
                            node.querySelectorAll('.nav-file, .nav-folder').forEach(el => {
                                this.applyIndicator(el as HTMLElement);
                            });
                        }
                    });
                }
            }
            this.updateFileExplorerIndicators();
        });

        this.explorerObserver.observe(document.body, { childList: true, subtree: true });
        this.register(() => this.explorerObserver.disconnect());

        const burst = setInterval(() => this.updateFileExplorerIndicators(), 1000);
        setTimeout(() => clearInterval(burst), 5500);
    }

    private applyIndicator(el: HTMLElement) {
        const show = this.settings.showIndicators;
        const isFolder = el.hasClass('nav-folder');
        const path = el.getAttribute('data-path') ||
                     el.querySelector(isFolder ? '.nav-folder-title' : '.nav-file-title')?.getAttribute('data-path');

        if (!path) return;
        const np = normalizePath(path);

        if (show) {
            let locked = false;
            if (isFolder) {
                locked = (this.settings.encryptedFolders || []).some(f => {
                    const nf = normalizePath(f);
                    return np === nf || np.startsWith(nf + '/');
                });
            } else {
                locked = this.encryptedPaths.has(np);
            }

            if (locked) {
                if (isFolder) el.addClass('is-encrypted-root');
                else el.addClass('is-encrypted');

                if (!el.querySelector('.uwu-icon-lock')) {
                    const iconSpan = document.createElement('span');
                    iconSpan.addClass('uwu-icon-lock');
                    setIcon(iconSpan, 'lock');
                    const titleContent = el.querySelector(isFolder ? '.nav-folder-title-content' : '.nav-file-title-content') ||
                                         el.querySelector(isFolder ? '.nav-folder-title' : '.nav-file-title') || el;
                    titleContent.prepend(iconSpan);
                }
            } else {
                el.removeClass('is-encrypted');
                el.removeClass('is-encrypted-root');
                el.querySelector('.uwu-icon-lock')?.remove();
            }
        } else {
            // Clean up all indicator elements
            el.removeClass('is-encrypted');
            el.removeClass('is-encrypted-root');
            el.querySelectorAll('.uwu-icon-lock').forEach(icon => icon.remove());
            el.querySelector('.uwu-icon-lock')?.remove();
        }
    }

    private updateFileExplorerIndicators = debounce(() => {
        const explorerLeaves = this.app.workspace.getLeavesOfType('file-explorer');
        explorerLeaves.forEach(leaf => {
            const container = leaf.view.containerEl;
            if (!container) return;
            const items = container.querySelectorAll('.nav-file, .nav-folder');
            items.forEach(el => this.applyIndicator(el as HTMLElement));
        });
    }, 200);

    private async handleResourceElement(el: HTMLElement) {
        await (this.vaultManager as any).readyPromise;
        let src = el.getAttribute('src');
        if (!src || src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('http')) return;

        const file = this.resolveFileFromSrc(src, el.getAttribute('data-path'));
        if (file instanceof TFile) {
            // Check if binary and should be encrypted
            const ext = file.extension.toLowerCase();
            const isBinary = ['pdf', 'mp3', 'wav', 'flac', 'm4a', 'ogg', '3gp', 'mp4', 'webm', 'ogv', 'mov', 'mkv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif', 'opus', 'jxl'].includes(ext);
            
            if (isBinary && (this.fileProcessor.shouldEncryptPath(file.path) || this.encryptedPaths.has(file.path))) {
                if (this.resourceProcessor.hasCached(file.path)) {
                    const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                    if (blobUrl) {
                        (el as any).src = blobUrl;
                        if ((el as any).load) (el as any).load();
                    }
                    return;
                }

                // Use lazy observer to avoid decrypting everything at once
                el.classList.add('uwu-lazy-resource');
                this.lazyResourceObserver.observe(el);
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
             if (this.resourceProcessor.hasCached(file.path)) {
                const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                if (blobUrl) el.style.backgroundImage = `url("${blobUrl}")`;
                return;
            }
            
            this.lazyResourceObserver.observe(el);
        }
    }

    private setupLazyResourceObserver() {
        this.lazyResourceObserver = new IntersectionObserver((entries) => {
            entries.forEach(async (entry) => {
                if (entry.isIntersecting) {
                    const el = entry.target as HTMLElement;
                    this.lazyResourceObserver.unobserve(el);
                    
                    const src = el.getAttribute('src') || (el.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/)?.[1]);
                    if (!src) return;

                    const file = this.resolveFileFromSrc(src, el.getAttribute('data-path'));
                    if (file instanceof TFile) {
                        const blobUrl = await this.resourceProcessor.getDecryptedBlobUrl(file);
                        if (blobUrl) {
                            if (el.style.backgroundImage) {
                                el.style.backgroundImage = `url("${blobUrl}")`;
                            } else {
                                (el as any).src = blobUrl;
                            }
                            el.setAttribute('data-uwu-decrypted', 'true');
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

        // Clean query params
        const rawSrc = src.split('?')[0];
        
        // Strategy 1: app:// or capacitor:// extraction
        if (rawSrc.startsWith('app://') || rawSrc.startsWith('capacitor://')) {
            const vaultRootResource = this.app.vault.adapter.getResourcePath('');
            const rawPrefix = vaultRootResource.split('?')[0];
            
            // Try matching encoded prefix AND decoded prefix
            const possiblePrefixes = [rawPrefix, decodeURIComponent(rawPrefix)];
            
            for (const prefix of possiblePrefixes) {
                if (rawSrc.toLowerCase().startsWith(prefix.toLowerCase())) {
                    const encodedVaultPath = rawSrc.substring(prefix.length);
                    const vaultPath = decodeURIComponent(encodedVaultPath);
                    const file = this.app.vault.getAbstractFileByPath(vaultPath);
                    if (file instanceof TFile) return file;
                }
            }
        }

        const decodedSrc = decodeURIComponent(rawSrc);

        // Strategy 2: Absolute/Relative Metadata Lookup
        const searchPath = decodedSrc.replace(/^(app|capacitor):\/\/localhost\//, '');
        let file = this.app.metadataCache.getFirstLinkpathDest(searchPath, dataPath || '');
        if (file instanceof TFile) return file;

        // Strategy 3: Filename-only fallback
        const fileName = searchPath.split('/').pop() || '';
        file = this.app.metadataCache.getFirstLinkpathDest(fileName, dataPath || '');
        if (file instanceof TFile) return file;

        return null;
    }

    private async isEncryptedFileAsync(file: TFile): Promise<boolean> {
        if (this.encryptedPaths.has(file.path)) return true;
        const sig = await this.getFileSignature(file.path);
        return sig ? this.isEncrypted(sig.buffer) : false;
    }

    private isImage(file: TFile): boolean {
        const ext = file.extension.toLowerCase();
        const type = (this.app as any).viewRegistry?.getTypeByExtension(ext);
        if (type === 'image') return true;
        
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'jfif', 'pjpeg', 'pjp', 'avif', 'heic', 'heif', 'jxl'];
        return imageExtensions.includes(ext);
    }

    async onunload() {
        document.body.removeClass('uwu-is-locked');
        document.body.removeClass('uwu-is-unlocked');

        this.resourceProcessor.clearCache();
        const adapter = this.app.vault.adapter;
        if (this.originalAdapterGetResourcePath) adapter.getResourcePath = this.originalAdapterGetResourcePath;
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

        if (this.lazyResourceObserver) {
            this.lazyResourceObserver.disconnect();
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
            .setName('Show indicators')
            .setDesc('Add lock icons to encrypted files and folders in the file explorer.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showIndicators)
                .onChange(async (value) => {
                    this.plugin.settings.showIndicators = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        (this.plugin as any).setupFileExplorerObserver();
                        (this.plugin as any).updateFileExplorerIndicators(); // Update folder roots instantly
                        (this.plugin as any).scanVaultForEncryptedFiles();
                    } else {
                        (this.plugin as any).encryptedPaths.clear();
                        (this.plugin as any).explorerObserver?.disconnect();
                        (this.plugin as any).updateFileExplorerIndicators();
                    }
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

        new Setting(containerEl)
            .setName('Panic Lock')
            .setDesc('Reload workspace upon vault lock to securely wipe JavaScript engine memory leaks.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.panicLock)
                .onChange(async (value) => {
                    this.plugin.settings.panicLock = value;
                    await this.plugin.saveSettings();
                }));
    }
}
