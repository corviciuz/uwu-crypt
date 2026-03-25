import init, { UwuCore, get_signature } from '../pkg/uwu_crypt.js';

let core: UwuCore | null = null;

async function setup(wasmBuffer: ArrayBuffer) {
    await init({ module_or_path: wasmBuffer });
}

self.onmessage = async (e) => {
    const { type, payload, id } = e.data;

    try {
        if (!core && type !== 'INIT' && type !== 'UNLOCK' && type !== 'CREATE') {
            throw new Error('Vault not unlocked');
        }

        switch (type) {
            case 'INIT':
                await setup(payload.wasmBuffer);
                const sig = get_signature();
                self.postMessage({ id, type: 'READY', payload: { signature: sig } });
                break;

            case 'CREATE':
                const [newSession, manifest] = await UwuCore.create_vault(payload.pass1, payload.pass2);
                core = newSession;
                // Zeroize passwords in worker memory
                delete payload.pass1;
                delete payload.pass2;
                self.postMessage({ id, type: 'CREATED', payload: { manifest } });
                break;

            case 'UNLOCK':
                core = await UwuCore.unlock_vault(payload.pass1, payload.pass2, payload.payload);
                // Zeroize passwords in worker memory
                delete payload.pass1;
                delete payload.pass2;
                self.postMessage({ id, type: 'UNLOCKED' });
                break;

            case 'ENCRYPT':
                const ciphertext = core!.encrypt_file(payload.data, payload.zstdLevel);
                self.postMessage({ id, type: 'ENCRYPTED', payload: { data: ciphertext } });
                break;

            case 'DECRYPT':
                const plaintext = core!.decrypt_file(payload.data);
                self.postMessage({ id, type: 'DECRYPTED', payload: { data: plaintext } });
                break;

            case 'LOCK':
                if (core) {
                    core.free();
                    core = null;
                }
                self.postMessage({ id, type: 'LOCKED' });
                break;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ id, type: 'ERROR', payload: { message: message || 'An unknown error occurred in the worker' } });
    }
};
