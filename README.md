# UWU-Crypt

High-security transparent file encryption for Obsidian, powered by Rust/WebAssembly.

---

## Cryptography

| Component | Algorithm |
|-----------|-----------|
| KDF | Dual-track Argon2id |
| AEAD | XChaCha20-Poly1305 |
| Compression | ZSTD (levels 1–22) |
| Cache masking | ChaCha8 |

Keys and salts are zeroized after every cryptographic operation.

## Features

- **Transparent encryption** — files retain their original names/extensions
- **On-the-fly interception** — DataAdapter monkey-patching (read/write/rename/remove)
- **Lazy media decryption** — IntersectionObserver decrypts resources on viewport entry
- **Session timeout** — auto-lock after configurable inactivity
- **Integrity checks** — inline verification on every I/O operation

## Storage Format

- Vault manifest: `.uwu/vault.uwu` (Base64-encoded MessagePack with salts + Argon2 params)
- Encrypted files: 16-byte `UWU_V1` signature + MessagePack(salt, nonce, ciphertext)

## Security Limitations

- **JS string immutability** — decrypted plaintext strings cannot be zeroed in the JS heap. Cache TTL is 500ms to minimize exposure.
- **Monkey-patch dependency** — conflicting plugins that overwrite DataAdapter methods will bypass encryption hooks. Integrity is verified on every I/O operation.
