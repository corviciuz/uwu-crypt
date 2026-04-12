use argon2::{Algorithm as ArgonAlgorithm, Argon2, Params as ArgonParams, Version as ArgonVersion};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use chacha20::ChaCha8;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use core::convert::TryInto;
use js_sys::{self, Uint8Array};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, ZeroizeOnDrop};
use zstd::stream::{decode_all, encode_all};

const STEALTH_SIG_KEY: &[u8] = b"UWU_V1";
const ARGON_P: u32 = 1;
const ARGON_OUT_LEN: usize = 32;

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[derive(Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
pub struct VaultManifest {
    #[serde(with = "serde_bytes")]
    signature: [u8; 16],
    #[serde(with = "serde_bytes")]
    auth_hash: [u8; 32],
    #[serde(with = "serde_bytes")]
    manifest_hmac: [u8; 32],
    #[serde(with = "serde_bytes")]
    salt_mix: Vec<u8>,
    #[serde(with = "serde_bytes")]
    salt_argon1: Vec<u8>,
    #[serde(with = "serde_bytes")]
    salt_argon2: Vec<u8>,
    pub argon_m: u32,
    pub argon_t: u32,
}

#[wasm_bindgen]
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct UwuCore {
    masked_key: [u8; 32],
    ephemeral_mask: [u8; 32],
}

#[derive(Serialize, Deserialize)]
struct FilePackage {
    #[serde(with = "serde_bytes")]
    salt: [u8; 32],
    #[serde(with = "serde_bytes")]
    nonce: [u8; 24],
    #[serde(with = "serde_bytes")]
    ciphertext: Vec<u8>,
}

fn derive_argon2id(password: &[u8], salt: &[u8], m: u32, t: u32) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    let params = ArgonParams::new(m, t, ARGON_P, Some(ARGON_OUT_LEN))
        .map_err(|e| format!("Argon2 params error: {:?}", e))?;

    let argon2 = Argon2::new(ArgonAlgorithm::Argon2id, ArgonVersion::V0x13, params);

    argon2
        .hash_password_into(password, salt, &mut out)
        .map_err(|e| format!("Argon2 hashing failed: {:?}", e))?;

    Ok(out)
}

fn derive_master_key(
    password: &[u8],
    s_mix: &[u8],
    s_argon1: &[u8],
    s_argon2: &[u8],
    m: u32,
    t: u32,
    progress_callback: Option<&js_sys::Function>,
) -> Result<[u8; 32], String> {
    // 1. Entropy Expansion via BLAKE3
    let mut hasher = blake3::Hasher::new();
    hasher.update(password);
    hasher.update(s_mix);
    let mut seed = *hasher.finalize().as_bytes();

    // 2. Dual-Track Hardening
    // Track 1
    let mut h1 = derive_argon2id(&seed[0..16], s_argon1, m, t)?;
    
    // Progress Report: 50%. We ignore the Result because JS exceptions 
    // in the callback should not interrupt the cryptographic process.
    if let Some(cb) = progress_callback {
        let _ = cb.call1(&JsValue::NULL, &JsValue::from(50.0));
    }

    // Track 2
    let mut h2 = derive_argon2id(&seed[16..32], s_argon2, m, t)?;
    
    seed.zeroize();

    // 3. Final Master Key mixing
    let mut final_hasher = blake3::Hasher::new();
    final_hasher.update(&h1);
    final_hasher.update(&h2);
    h1.zeroize();
    h2.zeroize();
    Ok(*final_hasher.finalize().as_bytes())
}

#[wasm_bindgen]
impl UwuCore {
    #[wasm_bindgen]
    pub fn create_vault(
        password: &[u8],
        m: u32,
        t: u32,
        progress_callback: Option<js_sys::Function>,
    ) -> Result<JsValue, String> {
        let mut s_mix = [0u8; 64];
        let mut s_argon1 = [0u8; 64];
        let mut s_argon2 = [0u8; 64];
        getrandom::fill(&mut s_mix).map_err(|e| e.to_string())?;
        getrandom::fill(&mut s_argon1).map_err(|e| e.to_string())?;
        getrandom::fill(&mut s_argon2).map_err(|e| e.to_string())?;

        let mut raw_master_key = derive_master_key(password, &s_mix, &s_argon1, &s_argon2, m, t, progress_callback.as_ref())?;
        
        // Progress Report: 75%. Same as above, exceptions are ignored to ensure vault creation completes.
        if let Some(cb) = progress_callback.as_ref() {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from(75.0));
        }
        let mut ephemeral_mask = [0u8; 32];
        getrandom::fill(&mut ephemeral_mask).map_err(|e| e.to_string())?;

        let mut masked_key = [0u8; 32];
        for i in 0..32 {
            masked_key[i] = raw_master_key[i] ^ ephemeral_mask[i];
        }
        let sig_hash = blake3::hash(STEALTH_SIG_KEY);
        let mut signature = [0u8; 16];
        signature.copy_from_slice(&sig_hash.as_bytes()[..16]);

        let auth_hash_full = blake3::keyed_hash(&raw_master_key, b"UWU_AUTH_CHECK");
        let mut auth_hash = [0u8; 32];
        auth_hash.copy_from_slice(auth_hash_full.as_bytes());

        // Создаём manifest без manifest_hmac для вычисления HMAC
        let manifest_partial = VaultManifest {
            signature,
            auth_hash,
            manifest_hmac: [0u8; 32],
            salt_mix: s_mix.to_vec(),
            salt_argon1: s_argon1.to_vec(),
            salt_argon2: s_argon2.to_vec(),
            argon_m: m,
            argon_t: t,
        };
        let mut manifest_bytes_partial = rmp_serde::to_vec(&manifest_partial).map_err(|e| e.to_string())?;

        // Вычисляем HMAC manifest из master_key
        let hmac = blake3::keyed_hash(&raw_master_key, &manifest_bytes_partial);
        let mut manifest_hmac = [0u8; 32];
        manifest_hmac.copy_from_slice(hmac.as_bytes());

        manifest_bytes_partial.zeroize(); // Wipe partial manifest buffer
        raw_master_key.zeroize();

        let manifest = VaultManifest {
            signature,
            auth_hash,
            manifest_hmac,
            salt_mix: s_mix.to_vec(),
            salt_argon1: s_argon1.to_vec(),
            salt_argon2: s_argon2.to_vec(),
            argon_m: m,
            argon_t: t,
        };
        let manifest_bytes = rmp_serde::to_vec(&manifest).map_err(|e| e.to_string())?;

        let session = UwuCore {
            masked_key,
            ephemeral_mask,
        };

        let array = js_sys::Array::new();
        array.push(&JsValue::from(session));
        array.push(&Uint8Array::from(manifest_bytes.as_slice()).into());
        Ok(array.into())
    }

    #[wasm_bindgen]
    pub fn unlock_vault(
        password: &[u8],
        manifest_bytes: &[u8],
        progress_callback: Option<js_sys::Function>,
    ) -> Result<UwuCore, String> {
        let manifest: VaultManifest =
            rmp_serde::from_slice(manifest_bytes).map_err(|e| e.to_string())?;
        let sig_hash = blake3::hash(STEALTH_SIG_KEY);
        if manifest.signature != sig_hash.as_bytes()[..16] {
            return Err("Invalid vault manifest signature".to_string());
        }

        let mut raw_master_key = derive_master_key(
            password,
            &manifest.salt_mix,
            &manifest.salt_argon1,
            &manifest.salt_argon2,
            manifest.argon_m,
            manifest.argon_t,
            progress_callback.as_ref(),
        )?;

        // Progress Report: 75%
        if let Some(cb) = progress_callback.as_ref() {
            let _ = cb.call1(&JsValue::NULL, &JsValue::from(75.0));
        }

        // Проверяем HMAC manifest
        let manifest_for_check = VaultManifest {
            signature: manifest.signature,
            auth_hash: manifest.auth_hash,
            manifest_hmac: [0u8; 32],
            salt_mix: manifest.salt_mix.clone(),
            salt_argon1: manifest.salt_argon1.clone(),
            salt_argon2: manifest.salt_argon2.clone(),
            argon_m: manifest.argon_m,
            argon_t: manifest.argon_t,
        };
        let manifest_bytes_partial = rmp_serde::to_vec(&manifest_for_check).map_err(|e| e.to_string())?;
        let expected_hmac = blake3::keyed_hash(&raw_master_key, &manifest_bytes_partial);
        if manifest.manifest_hmac != *expected_hmac.as_bytes() {
            raw_master_key.zeroize();
            return Err("Invalid manifest integrity".to_string());
        }

        let mut auth_check = *blake3::keyed_hash(&raw_master_key, b"UWU_AUTH_CHECK").as_bytes();
        if auth_check != manifest.auth_hash {
            auth_check.zeroize();
            raw_master_key.zeroize();
            return Err("Invalid password".to_string());
        }
        auth_check.zeroize();

        let mut ephemeral_mask = [0u8; 32];
        getrandom::fill(&mut ephemeral_mask).map_err(|e| e.to_string())?;

        let mut masked_key = [0u8; 32];
        for i in 0..32 {
            masked_key[i] = raw_master_key[i] ^ ephemeral_mask[i];
        }
        raw_master_key.zeroize();

        Ok(UwuCore {
            masked_key,
            ephemeral_mask,
        })
    }

    #[wasm_bindgen]
    pub fn test_performance(m: u32, t: u32, progress_callback: Option<js_sys::Function>) -> Result<(), String> {
        let mut pass = [0u8; 64];
        getrandom::fill(&mut pass).map_err(|e| e.to_string())?;
        let s_mix = [0u8; 64];
        let s_argon1 = [0u8; 64];
        let s_argon2 = [0u8; 64];
        derive_master_key(&pass, &s_mix, &s_argon1, &s_argon2, m, t, progress_callback.as_ref())?;
        pass.zeroize();
        Ok(())
    }

    #[wasm_bindgen]
    pub fn encrypt_file(&self, data: &[u8], zstd_level: i32) -> Result<Vec<u8>, String> {
        let mut file_salt = [0u8; 32];
        let mut nonce = [0u8; 24];

        getrandom::fill(&mut file_salt).map_err(|e| e.to_string())?;
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;

        let mut unmasked_key = [0u8; 32];
        for (i, item) in unmasked_key.iter_mut().enumerate() {
            *item = self.masked_key[i] ^ self.ephemeral_mask[i];
        }
        let file_key = blake3::keyed_hash(&unmasked_key, &file_salt);
        unmasked_key.zeroize();

        let mut compressed = encode_all(data, zstd_level).map_err(|e| e.to_string())?;
        let cipher =
            XChaCha20Poly1305::new_from_slice(file_key.as_bytes()).map_err(|e| e.to_string())?;

        let x_nonce: XNonce = nonce
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid nonce length")?;
        let ciphertext = cipher
            .encrypt(&x_nonce, compressed.as_slice())
            .map_err(|e| e.to_string())?;

        let package = FilePackage {
            salt: file_salt,
            nonce,
            ciphertext,
        };
        let res = rmp_serde::to_vec(&package).map_err(|e| e.to_string());
        compressed.zeroize();
        file_salt.zeroize();
        nonce.zeroize();
        res
    }

    #[wasm_bindgen]
    pub fn decrypt_file(&self, package_bytes: &[u8]) -> Result<js_sys::Uint8Array, String> {
        let package: FilePackage =
            rmp_serde::from_slice(package_bytes).map_err(|e| e.to_string())?;
        let mut unmasked_key = [0u8; 32];
        for (i, item) in unmasked_key.iter_mut().enumerate() {
            *item = self.masked_key[i] ^ self.ephemeral_mask[i];
        }
        let file_key = blake3::keyed_hash(&unmasked_key, &package.salt);
        unmasked_key.zeroize();

        let cipher =
            XChaCha20Poly1305::new_from_slice(file_key.as_bytes()).map_err(|e| e.to_string())?;
        let x_nonce: XNonce = package
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid nonce length")?;

        let mut compressed = cipher
            .decrypt(&x_nonce, package.ciphertext.as_slice())
            .map_err(|e| format!("File decryption failed: {}", e))?;

        let decompressed = decode_all(compressed.as_slice()).map_err(|e| e.to_string())?;
        compressed.zeroize();

        // Return owned Uint8Array — no shared buffer, no data race
        Ok(js_sys::Uint8Array::from(decompressed.as_slice()))
    }

    /// ChaCha8-based cache masking — cryptographically secure, counter-based
    #[wasm_bindgen]
    pub fn mask_data(&self, data: &mut [u8], nonce_4: &[u8]) {
        if nonce_4.len() != 4 {
            return;
        }
        // Build 12-byte nonce: 4 bytes random + 8 bytes zero counter
        let mut full_nonce = [0u8; 12];
        full_nonce[..4].copy_from_slice(nonce_4);

        let mut unmasked_key = [0u8; 32];
        for (i, item) in unmasked_key.iter_mut().enumerate() {
            *item = self.masked_key[i] ^ self.ephemeral_mask[i];
        }

        let mut cipher = ChaCha8::new(&unmasked_key.into(), &full_nonce.into());
        unmasked_key.zeroize();
        cipher.apply_keystream(data);
    }

    /// Unmask data with the same nonce — ChaCha8 is symmetric
    #[wasm_bindgen]
    pub fn unmask_data(&self, data: &mut [u8], nonce_4: &[u8]) {
        if nonce_4.len() != 4 {
            return;
        }
        let mut full_nonce = [0u8; 12];
        full_nonce[..4].copy_from_slice(nonce_4);

        let mut unmasked_key = [0u8; 32];
        for (i, item) in unmasked_key.iter_mut().enumerate() {
            *item = self.masked_key[i] ^ self.ephemeral_mask[i];
        }

        let mut cipher = ChaCha8::new(&unmasked_key.into(), &full_nonce.into());
        unmasked_key.zeroize();
        cipher.apply_keystream(data);
    }
}

#[wasm_bindgen]
pub fn get_signature() -> Vec<u8> {
    let sig_hash = blake3::hash(STEALTH_SIG_KEY);
    sig_hash.as_bytes()[..16].to_vec()
}

/// Parse manifest bytes and return {m, t} as JsValue
#[wasm_bindgen]
pub fn get_manifest_params(manifest_bytes: &[u8]) -> Result<JsValue, String> {
    let manifest: VaultManifest =
        rmp_serde::from_slice(manifest_bytes).map_err(|e| e.to_string())?;
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &JsValue::from("m"), &JsValue::from(manifest.argon_m)).map_err(|e| format!("Failed to set m: {:?}", e))?;
    js_sys::Reflect::set(&obj, &JsValue::from("t"), &JsValue::from(manifest.argon_t)).map_err(|e| format!("Failed to set t: {:?}", e))?;
    Ok(obj.into())
}


#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_sig_hash() {
        let sig_hash = blake3::hash(STEALTH_SIG_KEY);
        println!("SIG HASH: {:?}", sig_hash.as_bytes());
        assert_eq!(sig_hash.as_bytes()[0], 114);
    }
}
