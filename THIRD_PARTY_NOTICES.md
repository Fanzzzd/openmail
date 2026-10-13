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

The packaged app contains Electron and the runtime npm packages of `apps/desktop` and `packages/core` with their dependencies. Each npm package keeps its own license file inside the app's `node_modules`. Electron's license and Chromium's notices are published with each [Electron release](https://github.com/electron/electron/releases).

## Models downloaded at runtime

The optional semantic search models are not bundled. The app downloads them from Hugging Face only after the user turns semantic search on. Each model keeps the license on its model page. Image OCR uses macOS Vision and downloads nothing.

## Native helpers

The Swift and Objective-C helpers in `apps/desktop/native/` (Vision, Contacts, Photos, grammar, attachment apps, notification permissions) call macOS system frameworks only. They contain no third-party code.
