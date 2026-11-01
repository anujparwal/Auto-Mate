# Corresponding Source and Build Instructions for sharp-libvips / libvips 8.18.7

## 1. Upstream Recipe Metadata
- **Package**: `@img/sharp-win32-x64` (version `0.35.5`)
- **sharp-libvips Repository**: https://github.com/lovell/sharp-libvips
- **Recipe Release Tag**: `v1.3.4`
- **Recipe Commit SHA**: `ebb95f8add54eee8bed840e3fb587e4cbec857d7`
- **Release Date**: 2026-09-27
- **libvips Target Version**: `8.18.7`

## 2. Prebuilt Windows x64 Binary Distribution
The prebuilt Windows x64 dynamic shared libraries distributed with `@img/sharp-win32-x64` are produced using the libvips MXE cross-compilation pipeline:
- **Build Repository**: https://github.com/libvips/build-win64-mxe
- **Release Tag**: `v8.18.7`
- **Binary Archive**: https://github.com/libvips/build-win64-mxe/releases/download/v8.18.7/vips-dev-x64-web-8.18.7-static.zip
- **Archive Contents**:
  - `bin/libvips-42.dll` (main C engine)
  - `bin/libvips-cpp-8.18.7.dll` (C++ binding interface)
  - C headers and import libraries (`include/`, `lib/`)
  - Dependency metadata (`versions.json`)

## 3. Upstream libvips 8.18.7 Source Code
- **Upstream Repository**: https://github.com/libvips/libvips
- **Release Tag**: `v8.18.7`
- **Source Code Archive**: https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz
- **Source Web Tree**: https://github.com/libvips/libvips/tree/v8.18.7

## 4. Version-Matched Dependent Libraries (29 Components)
All 29 native libraries statically or dynamically linked into `libvips` 8.18.7 for `@img/sharp-win32-x64` are listed below with their pinned versions from `versions.properties` and authoritative upstream download locations:

| Component | Pinned Version | License Summary | Upstream Source Download Archive / Repository |
|---|---|---|---|
| **aom** | 3.15.1 | BSD 2-Clause + AOM Patent 1.0 | https://storage.googleapis.com/aom-releases/libaom-3.15.1.tar.gz |
| **archive** (libarchive) | 3.8.9 | BSD 2-Clause | https://github.com/libarchive/libarchive/releases/download/v3.8.9/libarchive-3.8.9.tar.xz |
| **cairo** | 1.18.6 | MPL-1.1 / LGPL-2.1 | https://cairographics.org/releases/cairo-1.18.6.tar.xz |
| **cgif** | 0.5.4 | MIT | https://github.com/dloebl/cgif/archive/v0.5.4.tar.gz |
| **exif** (libexif) | 0.6.26 | LGPL-2.1-or-later | https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz |
| **expat** | 2.8.5 | MIT | https://github.com/libexpat/libexpat/releases/download/R_2_8_5/expat-2.8.5.tar.xz |
| **ffi** (libffi) | 3.8.0 | MIT-style | https://github.com/libffi/libffi/releases/download/v3.8.0/libffi-3.8.0.tar.gz |
| **fontconfig** | 2.18.3 | fontconfig License (BSD-like) | https://gitlab.freedesktop.org/fontconfig/fontconfig/-/archive/2.18.3/fontconfig-2.18.3.tar.gz |
| **freetype** | 2.14.3 | FreeType FTL (BSD-like) / GPL-2.0 | https://github.com/freetype/freetype/archive/VER-2-14-3.tar.gz |
| **fribidi** | 1.0.17 | LGPL-2.1-or-later | https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz |
| **glib** | 2.90.0 | LGPL-2.1-or-later | https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz |
| **harfbuzz** | 14.5.0 | Old MIT | https://github.com/harfbuzz/harfbuzz/archive/14.5.0.tar.gz |
| **heif** (libheif) | 1.23.5 | LGPL-3.0-or-later / MIT | https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz |
| **highway** | 1.4.0 | Apache-2.0 / BSD 3-Clause | https://github.com/google/highway/archive/1.4.0.tar.gz |
| **imagequant** | 2.4.1 | BSD 2-Clause | https://github.com/lovell/libimagequant/archive/v2.4.1.tar.gz |
| **lcms** (Little-CMS) | 2.19.1 | MIT | https://github.com/mm2/Little-CMS/releases/download/lcms2.19.1/lcms2-2.19.1.tar.gz |
| **mozjpeg** | 0826579 | BSD 3-Clause / IJG / zlib | https://github.com/mozilla/mozjpeg/archive/0826579.tar.gz |
| **nsgif** (libnsgif) | (bundled in vips) | MIT | Bundled in libvips at `libvips/foreign/libnsgif` (upstream https://git.netsurf-browser.org/libnsgif.git) |
| **pango** | 1.58.2 | LGPL-2.0-or-later | https://download.gnome.org/sources/pango/1.58/pango-1.58.2.tar.xz |
| **pixman** | 0.46.4 | MIT | https://cairographics.org/releases/pixman-0.46.4.tar.gz |
| **png** (libpng) | 1.6.58 | libpng License v2 | https://github.com/pnggroup/libpng/archive/v1.6.58.tar.gz |
| **proxy-libintl** | 0.5 | LGPL-2.0-or-later | https://github.com/frida/proxy-libintl/archive/0.5.tar.gz |
| **rsvg** (librsvg) | 2.63.2 | LGPL-2.1-or-later | https://download.gnome.org/sources/librsvg/2.63/librsvg-2.63.2.tar.xz |
| **tiff** (libtiff) | 4.7.2 | LibTIFF License (BSD-like) | https://gitlab.com/libtiff/libtiff/-/archive/v4.7.2/libtiff-v4.7.2.tar.gz |
| **uhdr** (libultrahdr) | 2.0.2 | MIT / Apache-2.0 | https://github.com/google/libultrahdr/archive/v2.0.2.tar.gz |
| **vips** (libvips) | 8.18.7 | LGPL-2.1-or-later | https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz |
| **webp** (libwebp) | 1.6.0 | New BSD 3-Clause | https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz |
| **xml2** (libxml2) | 2.15.4 | MIT | https://download.gnome.org/sources/libxml2/2.15/libxml2-2.15.4.tar.xz |
| **zlib-ng** | 2.3.3 | zlib License | https://github.com/zlib-ng/zlib-ng/archive/2.3.3.tar.gz |

## 5. Instructions for Modification and Relinking / Replacement
Under Section 4(d)(1) of the GNU Lesser General Public License (LGPL) Version 3 and Section 6 of LGPL Version 2.1, users are permitted to modify libvips (or its covered LGPL dependencies) and relink or replace the resulting library in this application.

### Library File Locations
In the deployed Auto-Mate portable application directory:
- `node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`
- `node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.7.dll`
- `node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node` (native Node-API addon binding compiled against the C++ interface)

### Relinking / Replacement Procedure
1. Obtain the libvips 8.18.7 source code from the official release archive or git tag:
   ```bash
   git clone --branch v8.18.7 https://github.com/libvips/libvips.git
   ```
2. Apply your desired modifications to libvips source code. Ensure the public C and C++ API interfaces remain ABI-compatible.
3. Build the Windows x64 binaries using either:
   - The official libvips MXE cross-compilation environment: https://github.com/libvips/build-win64-mxe
   - Or native MSVC / Meson build following instructions at https://www.libvips.org/install.html
4. Copy the newly compiled DLLs:
   - Copy your updated `libvips-42.dll` to `node_modules/@img/sharp-win32-x64/lib/libvips-42.dll`.
   - Copy your updated `libvips-cpp-8.18.7.dll` to `node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.7.dll`.
5. Launch Auto-Mate using `Auto-Mate.exe`. The application will dynamically link against and execute your modified libvips libraries.
