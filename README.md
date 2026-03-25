# UWU Crypt - High-performance Vault Encryption

A technical implementation of a transparent encryption layer for Obsidian, utilizing a Rust WebAssembly core for cryptographic operations and binary data manipulation.

## Technical Architecture

### Cryptographic Primitive Stack

- **Key Derivation (KDF)**: Argon2id (M=524288, T=4, P=1, L=32) for strong resistance against side-channel and GPU-based brute-force attacks.
- **Encryption Algorithm**: XChaCha20-Poly1305 (AEAD) for high-performance authenticated encryption with 192-bit nonces, ensuring nonce-reuse resistance.
- **Key Fingerprinting**: BLAKE3-based keyed hashes for internal sub-key derivation (Master Key -> File Key).
- **ZSTD Compression**: Integrated ZSTD (levels 1-22) before encryption to minimize the storage footprint of compressed data.

### Secure Session Strategy

- **Master Key Security**: The derived master key is stored in memory using XOR-masking to mitigate cold-boot or memory-dump exploits.
- **Secure Memory Handling**: Critical buffers in the Rust core are wrapped in `ZeroizeOnDrop` to ensure memory is cleared immediately after cryptographic cycles.
- **Session Lifespan**: Automatic vault locking via a session timer and manual encryption/decryption control through context-menu actions.

### Data Injection & I/O Hooks

- **Transparent DataAdapter Interception**: The plugin hooks into Obsidian's `DataAdapter` (`read`, `readBinary`, `write`, `writeBinary`, `process`) to provide seamless on-the-fly decryption without unencrypted data ever touching the physical drive.
- **Selective Encryption Paths**: Flexible configuration allows for global vault encryption or targeted recursive encryption of specific folder paths.
- **Image Rendering**: Encrypted image assets are decrypted into memory-only Blob URLs via a dedicated `MutationObserver` and `MarkdownPostProcessor` pipeline, preventing unauthorized access in the editor and file explorer.

### Binary Storage Format

- **Serialization**: Optimized MessagePack format using `serde-bytes` for efficient binary storage (`BIN 8/16/32` headers).
- **File Structure**: Each encrypted file package includes a fixed-size header (16-byte signature), followed by the salt (32 bytes), nonce (24 bytes), and the compressed ciphertext.
