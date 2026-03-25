import { App, TFile } from 'obsidian';
import { VaultManager } from './vaultManager.ts';

export class ImageProcessor {
    private blobCache = new Map<string, string>(); // path -> blobUrl

    constructor(private plugin: any, private vaultManager: VaultManager, private isEncrypted: (buf: ArrayBuffer) => boolean) {}

    private get app(): App {
        return this.plugin.app;
    }

    async getDecryptedBlobUrl(file: TFile): Promise<string | null> {
        if (this.blobCache.has(file.path)) {
            return this.blobCache.get(file.path)!;
        }

        try {
            this.plugin.isProcessing = true;
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
            this.plugin.isProcessing = false;
        }

        return null;
    }

    private getMimeType(ext: string): string {
        switch (ext) {
            case 'png': return 'image/png';
            case 'jpg':
            case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'webp': return 'image/webp';
            case 'svg': return 'image/svg+xml';
            case 'bmp': return 'image/bmp';
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
