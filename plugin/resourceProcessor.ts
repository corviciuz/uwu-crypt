import { App, TFile } from 'obsidian';
import { VaultManager } from './vaultManager.ts';

export class ResourceProcessor {
    private blobCache = new Map<string, string>(); // path -> blobUrl

    constructor(private plugin: any, private vaultManager: VaultManager, private isEncrypted: (buf: ArrayBuffer) => boolean) {}

    private get app(): App {
        return this.plugin.app;
    }

    hasCached(path: string): boolean {
        return this.blobCache.has(path);
    }

    getCachedBlobUrl(path: string): string | undefined {
        return this.blobCache.get(path);
    }

    async getDecryptedBlobUrl(file: TFile): Promise<string | null> {
        if (this.blobCache.has(file.path)) {
            return this.blobCache.get(file.path)!;
        }

        if (!this.vaultManager.unlocked()) return null;
        await (this.vaultManager as any).readyPromise;

        try {
            this.plugin.processingPaths.add(file.path);
            const buffer = await this.app.vault.adapter.readBinary(file.path);
            if (this.isEncrypted(buffer)) {
                const sig = this.vaultManager.signature;
                const ciphertext = new Uint8Array(buffer).slice(sig.length);
                const plaintext = await this.vaultManager.decrypt(ciphertext);
                
                // Determine MIME type from extension
                const ext = file.extension.toLowerCase();
                const mimeType = this.getMimeType(ext);
                
                const blob = new Blob([plaintext as any], { type: mimeType });
                const url = URL.createObjectURL(blob);
                this.blobCache.set(file.path, url);
                return url;
            }
        } finally {
            this.plugin.processingPaths.delete(file.path);
        }

        return null;
    }

    private getMimeType(ext: string): string {
        switch (ext) {
            // Images
            case 'png': return 'image/png';
            case 'jpg':
            case 'jpeg':
            case 'jfif': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'webp': return 'image/webp';
            case 'svg': return 'image/svg+xml';
            case 'bmp': return 'image/bmp';
            case 'avif': return 'image/avif';
            case 'heic': return 'image/heic';
            case 'heif': return 'image/heif';
            case 'jxl': return 'image/jxl';
            case 'tif':
            case 'tiff': return 'image/tiff';
            case 'ico': return 'image/x-icon';
            
            // Audio
            case 'mp3': return 'audio/mpeg';
            case 'wav': return 'audio/wav';
            case 'm4a': return 'audio/mp4';
            case 'ogg': return 'audio/ogg';
            case '3gp': return 'audio/3gpp';
            case 'flac': return 'audio/flac';
            case 'aac': return 'audio/aac';
            
            // Video
            case 'mp4': return 'video/mp4';
            case 'webm': return 'video/webm';
            case 'ogv': return 'video/ogg';
            case 'mov': return 'video/quicktime';
            case 'mkv': return 'video/x-matroska';
            
            // Documents
            case 'pdf': return 'application/pdf';
            
            default: return 'application/octet-stream';
        }
    }

    clearCache() {
        for (const url of this.blobCache.values()) {
            URL.revokeObjectURL(url);
        }
        this.blobCache.clear();
    }

    revokeUrl(path: string) {
        const url = this.blobCache.get(path);
        if (url) {
            URL.revokeObjectURL(url);
            this.blobCache.delete(path);
        }
    }
}
