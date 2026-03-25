import init, { UwuCore, get_signature } from '../pkg/uwu_crypt.js';

let core: UwuCore | null = null;

async function setup(wasmBuffer: ArrayBuffer) {
    await init({ module_or_path: wasmBuffer });
}

self.onmessage = async (e) => {
    const { type, payload, id } = e.data;

    try {
        if (!core && type !== 'INIT' && type !== 'UNLOCK' && type !== 'CREATE' && type !== 'TEST_PERF') {
            throw new Error('Vault not unlocked');
        }

        switch (type) {
            case 'INIT':
                await setup(payload.wasmBuffer);
                const sig = get_signature();
                self.postMessage({ id, type: 'READY', payload: { signature: sig } });
                break;

            case 'CREATE':
                const [newSession, manifest] = await (UwuCore as any).create_vault(payload.password, payload.m, payload.t);
                core = newSession;
                payload.password = "";
                self.postMessage({ id, type: 'CREATED', payload: { manifest } });
                break;

            case 'UNLOCK':
                core = await (UwuCore as any).unlock_vault(payload.password, payload.payload);
                payload.password = "";
                self.postMessage({ id, type: 'UNLOCKED' });
                break;

            case 'TEST_PERF':
                (UwuCore as any).test_performance(payload.m, payload.t); // Performance measured by the caller in JS
                self.postMessage({ id, type: 'TEST_DONE' });
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
