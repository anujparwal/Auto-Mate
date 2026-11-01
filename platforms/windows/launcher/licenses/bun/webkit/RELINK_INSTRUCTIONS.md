# WebKit / JavaScriptCore Source and Relinking Directions for Bun v1.4.4

Bun v1.4.4 statically links JavaScriptCore and WebCore from WebKit, licensed primarily under LGPL-2.1 / LGPL-2.0.
In compliance with LGPL relinking requirements:

## Upstream Repository and Pinned Version
- Pinned WebKit Commit: `d6375c72affe0f70222cdcb45012b10f0bf3a9d5`
- WebKit Source Repository: <https://github.com/oven-sh/WebKit>
- Pinned Release Tag / Autobuild: `autobuild-d6375c72affe0f70222cdcb45012b10f0bf3a9d5`
- Official Prebuilt Windows x64 Archive:
  <https://github.com/oven-sh/WebKit/releases/download/autobuild-d6375c72affe0f70222cdcb45012b10f0bf3a9d5/bun-webkit-windows-amd64.tar.gz>
- Pinned Build Specification in Bun Repository:
  `scripts/build/deps/webkit.ts` (WEBKIT_VERSION = "d6375c72affe0f70222cdcb45012b10f0bf3a9d5")
  `scripts/sync-webkit-source.ts`

## Relinking and Rebuilding Instructions

To rebuild and relink Bun with a modified JavaScriptCore/WebKit:

1. Clone the Bun repository at tag `bun-v1.4.4`:
   ```bash
   git clone --branch bun-v1.4.4 https://github.com/oven-sh/bun.git
   cd bun
   ```

2. Clone oven-sh's patched WebKit into `vendor/WebKit`:
   ```bash
   git clone https://github.com/oven-sh/WebKit vendor/WebKit
   cd vendor/WebKit
   git checkout d6375c72affe0f70222cdcb45012b10f0bf3a9d5
   cd ../..
   # Alternatively: bun sync-webkit-source
   ```

3. Apply your modifications to `vendor/WebKit` (e.g. within `Source/JavaScriptCore`).

4. Compile JavaScriptCore and relink the Bun binary:
   ```bash
   bun run build:local
   ```
   On Windows (using PowerShell in MSVC x64 developer environment):
   - Pre-build hook runs `vendor/WebKit/build-icu.ps1` to compile static ICU libraries (`sicudt.lib`, `sicuin.lib`, `sicuuc.lib`).
   - CMake compiles the `jsc` target into static archives (`libJavaScriptCore.lib`, `libWTF.lib`, `libbmalloc.lib`).
   - Bun's C++ bindings in `src/jsc/bindings/` are compiled and statically linked with JavaScriptCore, outputting a new `bun.exe` executable incorporating your changes.
