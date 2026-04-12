import init, { UwuCore, get_signature, init_panic_hook, zeroize_scratch } from '../pkg/uwu_crypt.js';

let core: UwuCore | null = null;

async function setup(wasmBuffer: ArrayBuffer) {
    await init({ module_or_path: wasmBuffer });
    init_panic_hook();
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
                (self as any).postMessage({ id, type: 'READY', payload: { signature: sig } }, [sig.buffer]);
                break;

            case 'CREATE':
                const create_progress_cb = (p: number) => {
                    (self as any).postMessage({ id, type: 'PROGRESS', payload: { progress: p } });
                };
                const [newSession, manifest] = (UwuCore as any).create_vault(payload.password, payload.m, payload.t, create_progress_cb);
                core = newSession;
                (self as any).postMessage({ id, type: 'CREATED', payload: { manifest } }, [manifest.buffer]);
                break;

            case 'UNLOCK':
                const unlock_progress_cb = (p: number) => {
                    (self as any).postMessage({ id, type: 'PROGRESS', payload: { progress: p } });
                };
                core = (UwuCore as any).unlock_vault(payload.password, payload.payload, unlock_progress_cb);
                (self as any).postMessage({ id, type: 'UNLOCKED' });
                break;

            case 'TEST_PERF':
                const perf_progress_cb = (p: number) => {
                    (self as any).postMessage({ id, type: 'PROGRESS', payload: { progress: p } });
                };
                await (UwuCore as any).test_performance(payload.m, payload.t, perf_progress_cb); 
                (self as any).postMessage({ id, type: 'TEST_DONE' });
                break;

            case 'ENCRYPT':
                const ciphertext = core!.encrypt_file(payload.data, payload.zstdLevel);
                (self as any).postMessage({ id, type: 'ENCRYPTED', payload: { data: ciphertext } }, [ciphertext.buffer]);
                break;

            case 'DECRYPT':
                const view = core!.decrypt_file(payload.data);
                const plaintext = view.slice(); // Copy to separate buffer for transfer
                zeroize_scratch(); // IMMEDIATELY wipe WASM memory
                (self as any).postMessage({ id, type: 'DECRYPTED', payload: { data: plaintext } }, [plaintext.buffer]);
                break;

            case 'LOCK':
                if (core) {
                    core.free();
                    core = null;
                }
                zeroize_scratch();
                (self as any).postMessage({ id, type: 'LOCKED' });
                break;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        (self as any).postMessage({ id, type: 'ERROR', payload: { message: message || 'An unknown error occurred in the worker' } });
    } finally {
        if (payload) {
            try {
                if (payload.password instanceof Uint8Array && payload.password.buffer.byteLength > 0) {
                    payload.password.fill(0);
                }
                if (payload.data instanceof Uint8Array && payload.data.buffer.byteLength > 0) {
                    payload.data.fill(0);
                }
                if (payload.payload instanceof Uint8Array && payload.payload.buffer.byteLength > 0) {
                    payload.payload.fill(0);
                }
            } catch {}
        }
    }
};
