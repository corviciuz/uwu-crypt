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
- **Panic Lock** — aggressively destroys JavaScript memory leaks by reloading the application context upon locking
- **Bring Your Own Manifest (BYOM)** — initialize vault using existing manifest backup from settings

## Storage Format

- Vault manifest: `.uwu/vault.uwu` (Base64-encoded MessagePack with salts + Argon2 params)
- Encrypted files: 16-byte `UWU_V1` signature + MessagePack(salt, nonce, ciphertext)

## Security Limitations

- **JS string immutability** — decrypted plaintext strings cannot be directly wiped from the V8 (JavaScript) heap via code. We mitigate this using a strict 500ms cache TTL and the **Panic Lock** feature, which wipes the entire engine state upon vault lock.
- **Monkey-patch dependency** — conflicting plugins that overwrite DataAdapter methods will bypass encryption hooks. Integrity is verified on every I/O operation.

## Build Instructions

To build the plugin from source, you need the following system dependencies installed:
- **Node.js** and **npm**
- **Rust** (and Cargo)
- **wasm-pack** (install via `cargo install wasm-pack`)
- A C/C++ build toolchain like **Clang/LLVM** or GCC (required for compiling the ZSTD C bindings in the Rust crate).

### Build Steps

1. Install Node.js dependencies:
   ```bash
   npm install
   ```

2. Build the WebAssembly core and compile the TypeScript plugin:
   ```bash
   npm run build
   ```
   *(Note: The `npm run build` script automatically invokes `wasm-pack build` under the hood before running `tsc` and `esbuild`)*
