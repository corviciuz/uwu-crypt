# UWU-Crypt

**UWU-Crypt** is a high-performance transparent encryption extension for Obsidian, designed to provide seamless on-the-fly data protection without altering file extensions or the underlying vault structure. By combining a robust Rust/WebAssembly cryptographic core with deep integration into the Obsidian I/O API, this solution ensures comprehensive data security including transparent media handling via lazy decryption, automatic protection of moved files, and strict blocking of destructive operations in protected areas when the vault is locked. (\*ゝω・)ﾉ

---

## Technical Architecture & Core Technologies

### 1. Cryptographic Primitive Stack (WASM Core)

The engine is built on **Rust** and compiled into **WebAssembly (WASM)**, providing both near-native performance and strict memory isolation from the main JavaScript thread.

- **Key Derivation (KDF)**: Utilizes **Argon2id** (Parameters: M=512MB, T=4, P=1, L=32) for strong resistance against GPU-based brute-force and side-channel attacks.
- **Authenticated Encryption (AEAD)**: Employs **XChaCha20-Poly1305** with 192-bit nonces, ensuring nonce-reuse resistance and verifiable data integrity.
- **ZSTD Compression**: Integrated **Zstd** (levels 1-22) performed before the encryption cycle to minimize the storage footprint of compressed encrypted data.

### 2. Secure Memory Strategy (RAM Hardening)

The plugin implements a "clean memory" strategy to minimize the lifespan of sensitive data in RAM:

- **Zeroization**: Explicit memory clearing (zeroing out buffers) for all master keys, session sub-keys, and decrypted plaintext fragments immediately upon completion of cryptographic cycles or vault locking. ( `◡` )
- **XOR Masking**: Decrypted data within the internal cache is stored using ephemeral XOR-masking. Original buffers are only reconstructed momentarily before being passed to the UI.
- **System Isolation**: Cryptographic secrets never leave the WASM memory space; JS access is strictly limited via a defined boundary API.

### 3. I/O Interception & DataAdapter Hooking

Instead of a virtual filesystem, UWU-Crypt performs deep interception at the **DataAdapter** layer of the Obsidian application:

- **Monkey-patching**: Base methods (`read`, `write`, `readBinary`, `writeBinary`, `append`, and `process`) are patched to perform on-the-fly encryption/decryption transparently to other plugins and the Obsidian core.
- **Atomic Operations**: Encryption is performed atomically before disk commit, ensuring that plaintext is never written to physical storage.
- **Structural Integrity**: The plugin intercepts destructive calls like `remove`, `rename`, and `mkdir` within protected paths, blocking them if the vault is currently locked to prevent accidental data loss.

### 4. UI & Rendering Optimizations

Modern web technologies are utilized to ensure a smooth, professional user experience:

- **Lazy Decryption (IntersectionObserver)**: Encrypted media assets (images, etc.) are only decrypted and rendered when they enter the user's viewport, significantly reducing CPU overloads and RAM consumption for large notes.
- **Persistent View Containers**: `UwuView` utilizes a static DOM structure that toggles visibility instead of rebuilding the nodes, eliminating the "blank frame" flicker during tab switching.
- **Implicit View Selection**: Instantaneous leaf-level hooking of `setViewState` allows the plugin to redirect Obsidian to the "Locked" view before any markdown rendering occurs, providing a flicker-free transition for protected files. (・∀・)ノ

### 5. Stealth Mode & Storage Format

Files on disk retain their original filenames and extensions to maintain compatibility with external backup tools and avoid breaking internal Obsidian linking systems:

- **Binary Signature**: Every encrypted file starts with a unique 16-byte `UWU_V1` signature for instant identification.
- **Serialization**: Salt and encryption parameters are packed using the **MessagePack** format, ensuring a minimal metadata overhead.
