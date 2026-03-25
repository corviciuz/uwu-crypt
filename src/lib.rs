use argon2::{Algorithm as ArgonAlgorithm, Argon2, Params as ArgonParams, Version as ArgonVersion};
use blake3;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit},
};
use core::convert::TryInto;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, ZeroizeOnDrop};
use zstd::stream::{decode_all, encode_all};

const STEALTH_SIG_KEY: &[u8] = b"UWU_V1";
const ARGON_M: u32 = 524288;
const ARGON_T: u32 = 4;
const ARGON_P: u32 = 1;
const ARGON_OUT_LEN: usize = 32;

#[derive(Serialize, Deserialize)]
pub struct VaultManifest {
    #[serde(with = "serde_bytes")]
    signature: [u8; 16],
    #[serde(with = "serde_bytes")]
    auth_hash: [u8; 32],
    #[serde(with = "serde_bytes")]
    salt_mix: Vec<u8>,
    #[serde(with = "serde_bytes")]
    salt_argon: Vec<u8>,
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

fn derive_argon2id(password: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    let params = ArgonParams::new(ARGON_M, ARGON_T, ARGON_P, Some(ARGON_OUT_LEN))
        .map_err(|e| format!("Argon2 params error: {:?}", e))?;

    let argon2 = Argon2::new(ArgonAlgorithm::Argon2id, ArgonVersion::V0x13, params);

    argon2
        .hash_password_into(password, salt, &mut out)
        .map_err(|e| format!("Argon2 hashing failed: {:?}", e))?;

    Ok(out)
}

fn derive_master_key(p1: &str, p2: &str, s_mix: &[u8], s_argon: &[u8]) -> Result<[u8; 32], String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(p1.as_bytes());
    hasher.update(p2.as_bytes());
    hasher.update(s_mix);
    let mut mixed_seed = *hasher.finalize().as_bytes();
    let key = derive_argon2id(&mixed_seed, s_argon)?;
    mixed_seed.zeroize();
    Ok(key)
}

#[wasm_bindgen]
impl UwuCore {
    #[wasm_bindgen]
    pub async fn create_vault(pass1: &str, pass2: &str) -> Result<JsValue, String> {
        let mut s_mix = [0u8; 64];
        let mut s_argon = [0u8; 64];
        getrandom::fill(&mut s_mix).map_err(|e| e.to_string())?;
        getrandom::fill(&mut s_argon).map_err(|e| e.to_string())?;

        let mut raw_master_key = derive_master_key(pass1, pass2, &s_mix, &s_argon)?;
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
        let mut auth_hash = *blake3::keyed_hash(&raw_master_key, b"UWU_AUTH_CHECK").as_bytes();
        auth_hash.copy_from_slice(auth_hash_full.as_bytes());

        raw_master_key.zeroize();

        let manifest = VaultManifest {
            signature,
            auth_hash,
            salt_mix: s_mix.to_vec(),
            salt_argon: s_argon.to_vec(),
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
    pub async fn unlock_vault(
        pass1: &str,
        pass2: &str,
        manifest_bytes: &[u8],
    ) -> Result<UwuCore, String> {
        let manifest: VaultManifest =
            rmp_serde::from_slice(manifest_bytes).map_err(|e| e.to_string())?;
        let sig_hash = blake3::hash(STEALTH_SIG_KEY);
        if manifest.signature != sig_hash.as_bytes()[..16] {
            return Err("Invalid vault manifest signature".to_string());
        }

        let mut raw_master_key =
            derive_master_key(pass1, pass2, &manifest.salt_mix, &manifest.salt_argon)?;

        let mut auth_check = *blake3::keyed_hash(&raw_master_key, b"UWU_AUTH_CHECK").as_bytes();
        if auth_check != manifest.auth_hash {
            auth_check.zeroize();
            raw_master_key.zeroize();
            return Err("Invalid passwords".to_string());
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
    pub fn encrypt_file(&self, data: &[u8], zstd_level: i32) -> Result<Vec<u8>, String> {
        let mut file_salt = [0u8; 32];
        let mut nonce = [0u8; 24];
        let mut unmasked_key = [0u8; 32];

        getrandom::fill(&mut file_salt).map_err(|e| e.to_string())?;
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;

        for i in 0..32 {
            unmasked_key[i] = self.masked_key[i] ^ self.ephemeral_mask[i];
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
        res
    }

    #[wasm_bindgen]
    pub fn decrypt_file(&self, package_bytes: &[u8]) -> Result<Vec<u8>, String> {
        let package: FilePackage =
            rmp_serde::from_slice(package_bytes).map_err(|e| e.to_string())?;
        let mut unmasked_key = [0u8; 32];

        for i in 0..32 {
            unmasked_key[i] = self.masked_key[i] ^ self.ephemeral_mask[i];
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

        let decompressed = decode_all(compressed.as_slice()).map_err(|e| e.to_string());
        compressed.zeroize();
        decompressed
    }

    #[wasm_bindgen]
    pub fn mask_data(&self, data: &mut [u8], mask: &[u8]) {
        if mask.is_empty() {
            return;
        }
        for (i, byte) in data.iter_mut().enumerate() {
            *byte ^= mask[i % mask.len()];
        }
    }
}

#[wasm_bindgen]
pub fn get_signature() -> Vec<u8> {
    let sig_hash = blake3::hash(STEALTH_SIG_KEY);
    sig_hash.as_bytes()[..16].to_vec()
}

use js_sys::Uint8Array;

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
