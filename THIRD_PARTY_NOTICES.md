# Third-party notices

OpenMail is MIT licensed (see [LICENSE](LICENSE)). The desktop app ships the assets and data below, which come under their own licenses. The packaged app includes this file in `OpenMail.app/Contents/Resources/`.

## Provider icons

The account list and the add-account screen show provider marks. `unplugin-icons` compiles them from Iconify icon sets at build time.

| Icons                                      | Source                                                                             | License   |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | --------- |
| Microsoft Outlook, iCloud, Yahoo, Fastmail | [selfh.st icons](https://selfh.st/icons), via `@iconify-json/selfhst`              | CC BY 4.0 |
| Gmail                                      | [gilbarbara/logos](https://github.com/gilbarbara/logos), via `@iconify-json/logos` | CC0 1.0   |
| QQ                                         | [theSVG](https://github.com/glincker/thesvg), via `@iconify-json/thesvg-color`     | MIT       |
| Generic mail and interface icons           | [Lucide](https://lucide.dev), via `lucide-react`                                   | ISC       |

Icons by selfh.st, https://selfh.st/icons, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The app's About panel carries the same credit.

Brand marks are trademarks of their owners. OpenMail shows them only to identify the provider an account belongs to.

## Unicode CLDR data

`packages/core/src/calendar/windows-zones.ts` contains the Windows to IANA time zone mapping from Unicode CLDR, under the Unicode License v3. The full text is in [docs/licenses/unicode-3.0.txt](docs/licenses/unicode-3.0.txt).

## npm dependencies and Electron

The packaged app contains Electron and npm packages in two forms:

- The runtime dependencies of `apps/desktop` and `packages/core` sit in the app's `node_modules`, each with the license file from its npm package.
- Vite compiles the libraries the app window imports (React, Base UI, TanStack Router, Lucide and others) into the app's JavaScript bundles, so no `node_modules` copy of them ships. The build lists each of them with its license text in `OpenMail.app/Contents/Resources/licenses/bundled/`: `renderer.txt` for the app window and `web.txt` for the remote access web app.

`scripts/check-licenses.mjs` fails when a shipped package has no license file and no notice in this repository. Electron's license and Chromium's notices are published with each [Electron release](https://github.com/electron/electron/releases).

The license texts named in this file are in [docs/licenses/](docs/licenses/). The packaged app ships them in `OpenMail.app/Contents/Resources/licenses/`.

These packages ship without a license file. Their notices are in [npm-packages-without-license.txt](docs/licenses/npm-packages-without-license.txt):

| Package                                                                      | License                                 |
| ---------------------------------------------------------------------------- | --------------------------------------- |
| `@img/sharp-libvips-darwin-arm64`, `-x64` 1.3.4                              | LGPL-3.0-or-later, see the next section |
| `@napi-rs/keyring-darwin-arm64`, `-x64` 2.1.1                                | MIT                                     |
| `@napi-rs/canvas-darwin-arm64`, `-x64` 1.0.11                                | MIT, with Skia under BSD 3-Clause       |
| `onnxruntime-node` 1.30.0, `onnxruntime-common`, `onnxruntime-web`           | MIT                                     |
| `sqlite-vec`, `sqlite-vec-darwin-arm64`, `-x64` 0.1.9                        | MIT or Apache-2.0, used under MIT       |
| `lazy-val` 1.0.5                                                             | MIT                                     |
| `guid-typescript` 1.0.9                                                      | ISC                                     |
| `redis`, `@redis/client`, `-bloom`, `-json`, `-search`, `-time-series` 6.2.1 | MIT                                     |
| `qrcode-generator` 2.0.4, compiled into the bundles                          | MIT                                     |

The ONNX Runtime library inside `onnxruntime-node` includes third-party code. Microsoft's notices for it are in [onnxruntime.txt](docs/licenses/onnxruntime.txt).

## libvips (via sharp)

Semantic search uses `@huggingface/transformers`, which loads `sharp` 0.35.5 (Apache-2.0) to read images. `sharp` uses libvips from `@img/sharp-libvips-darwin-arm64` or `@img/sharp-libvips-darwin-x64` 1.3.4. That package is licensed LGPL-3.0-or-later.

The package is one dylib, `libvips-cpp.8.18.7.dylib`, with libvips and the libraries below statically linked into it. Sharp's native module (`sharp-darwin-<arch>-0.35.5.node`) loads the dylib dynamically through `@rpath`. Both sit outside the asar archive in `OpenMail.app/Contents/Resources/app.asar.unpacked/node_modules/@img/`. You can replace the dylib with one you build from modified sources using [sharp-libvips](https://github.com/lovell/sharp-libvips/tree/v1.3.4), then re-sign the app (`codesign --force --deep --sign - OpenMail.app`). The source code and build scripts for this version are in that repository at tag `v1.3.4`.

| Library       | Version    | License                                                     |
| ------------- | ---------- | ----------------------------------------------------------- |
| libvips       | 8.18.7     | LGPL-3.0-or-later                                           |
| aom           | 3.15.1     | BSD 2-Clause and Alliance for Open Media Patent License 1.0 |
| cairo         | 1.18.6     | MPL-1.1                                                     |
| cgif          | 0.5.4      | MIT                                                         |
| expat         | 2.8.5      | MIT                                                         |
| fontconfig    | 2.18.3     | fontconfig license (BSD-like)                               |
| freetype      | 2.14.3     | FreeType License (BSD-like)                                 |
| fribidi       | 1.0.17     | LGPL-3.0-or-later                                           |
| glib          | 2.90.0     | LGPL-3.0-or-later                                           |
| harfbuzz      | 14.5.0     | MIT                                                         |
| highway       | 1.4.0      | BSD 3-Clause                                                |
| lcms          | 2.19.1     | MIT                                                         |
| libarchive    | 3.8.9      | BSD 2-Clause                                                |
| libexif       | 0.6.26     | LGPL-3.0-or-later                                           |
| libffi        | 3.8.0      | MIT                                                         |
| libheif       | 1.23.5     | LGPL-3.0-or-later                                           |
| libimagequant | 2.4.1      | BSD 2-Clause                                                |
| libnsgif      | in libvips | MIT                                                         |
| libpng        | 1.6.58     | libpng license                                              |
| librsvg       | 2.63.2     | LGPL-3.0-or-later                                           |
| libtiff       | 4.7.2      | libtiff license (BSD-like)                                  |
| libultrahdr   | 2.0.2      | MIT and Apache-2.0                                          |
| libwebp       | 1.6.0      | BSD 3-Clause                                                |
| libxml2       | 2.15.4     | MIT                                                         |
| mozjpeg       | 0826579    | IJG License, BSD 3-Clause and zlib                          |
| pango         | 1.58.2     | LGPL-3.0-or-later                                           |
| pixman        | 0.46.4     | MIT                                                         |
| proxy-libintl | 0.5        | LGPL-3.0-or-later                                           |
| zlib-ng       | 2.3.3      | zlib                                                        |

The licenses come from the package's README and each project's license file. Libraries under the LGPL are used under LGPL-3.0 through the "any later version" clause of LGPL-2.0 or LGPL-2.1. The texts are in [lgpl-3.0.txt](docs/licenses/lgpl-3.0.txt), [gpl-3.0.txt](docs/licenses/gpl-3.0.txt) (LGPL-3.0 builds on it), [mpl-1.1.txt](docs/licenses/mpl-1.1.txt) and [aom-patent-license-1.0.txt](docs/licenses/aom-patent-license-1.0.txt). The copyright notices and license terms of the other libraries are in [libvips-dependencies.txt](docs/licenses/libvips-dependencies.txt).

## Models downloaded at runtime

The optional semantic search models are not bundled. The app downloads them from Hugging Face only after the user turns semantic search on. Each model keeps the license on its model page. Image OCR uses macOS Vision and downloads nothing.

## Native helpers

The Swift and Objective-C helpers in `apps/desktop/native/` (Vision, Contacts, Photos, grammar, attachment apps, notification permissions) call macOS system frameworks only. They contain no third-party code.
