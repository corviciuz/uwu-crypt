import { App, TFile } from 'obsidian';
import { VaultManager } from './vaultManager.ts';

const BLOB_TTL = 30000; // 30s — blob URLs need time for streaming, seek, preload

export class ResourceProcessor {
    private blobCache = new Map<string, { url: string; timer: number | null }>(); // path -> { url, timer }

    constructor(
        private plugin: any,
        private vaultManager: VaultManager,
        private getSigLen: (buf: ArrayBuffer) => number,
        public originalReadBinary: ((path: string) => Promise<ArrayBuffer>) | null = null
    ) {}

    private get app(): App {
        return this.plugin.app;
    }

    hasCached(path: string): boolean {
        return this.blobCache.has(path);
    }

    getCachedBlobUrl(path: string): string | undefined {
        const entry = this.blobCache.get(path);
        if (entry) {
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = window.setTimeout(() => this.revokeUrl(path), BLOB_TTL);
            return entry.url;
        }
        return undefined;
    }

    async getDecryptedBlobUrl(file: TFile): Promise<string | null> {
        if (this.blobCache.has(file.path)) {
            const entry = this.blobCache.get(file.path)!;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = window.setTimeout(() => this.revokeUrl(file.path), BLOB_TTL);
            return entry.url;
        }

        if (!this.vaultManager.unlocked()) return null;
        await (this.vaultManager as any).readyPromise;

        try {
            const adapter = this.app.vault.adapter;
            const buffer = this.originalReadBinary
                ? await this.originalReadBinary(file.path)
                : await adapter.readBinary(file.path);

            const sigLen = this.getSigLen(buffer);
            if (sigLen > 0) {
                const ciphertext = new Uint8Array(buffer).slice(sigLen);
                const plaintext = await this.vaultManager.decrypt(ciphertext);

                const ext = file.extension.toLowerCase();
                const mimeType = this.getMimeType(ext);

                const blob = new Blob([plaintext as any], { type: mimeType });
                const url = URL.createObjectURL(blob);

                const timer = window.setTimeout(() => this.revokeUrl(file.path), BLOB_TTL);
                this.blobCache.set(file.path, { url, timer });
                try { if (plaintext.buffer.byteLength > 0) plaintext.fill(0); } catch {}

                return url;
            }
        } catch (e) {
            console.error('ResourceProcessor: decryption error for', file.path, e);
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
            case 'opus': return 'audio/opus';
            
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
        for (const entry of this.blobCache.values()) {
            if (entry.timer) clearTimeout(entry.timer);
            URL.revokeObjectURL(entry.url);
        }
        this.blobCache.clear();
    }

    revokeUrl(path: string) {
        const entry = this.blobCache.get(path);
        if (entry) {
            if (entry.timer) clearTimeout(entry.timer);
            URL.revokeObjectURL(entry.url);
            this.blobCache.delete(path);
        }
    }
}
