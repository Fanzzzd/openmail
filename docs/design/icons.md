# Icons

## App icon

The mark is the Flap o: a square o whose counter is an envelope, with the V fold hanging from the counter's top edge. It reads as the o of openmail and as mail, and stays an envelope at 32 px. The o and the flap are two separate Liquid Glass pieces with a hairline between them, so the flap catches its own highlight. The mark came out of eight design rounds ("01 Flap o" in round 8). `docs/design/icon-source/icons.mjs` generates every icon source from one geometry; earlier generators and rejected options are in git history.

Files in `apps/desktop/build/`:

| File                                      | Use                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `icon.icon`                               | Icon Composer master; `mac.icon` in electron-builder.config.cjs points here                             |
| `icon-small.icon`                         | Heavier variant for the 16 and 32 px icns slots                                                         |
| `icon-dev.icon`, `icon-dev.png`           | Development icon; unpackaged runs show the PNG in the Dock and windows (`src/main/app/app-identity.ts`) |
| `icon-preview.icon`, `icon-preview.png`   | Preview icon for a future preview channel. No build uses it yet                                         |
| `icon.svg`                                | Flat vector version on the macOS grid, for places that cannot use the `.icon` bundle                    |
| `icon.png`                                | 1024 px Liquid Glass render                                                                             |
| `icon.icns`                               | All sizes 16 to 512 at @1x and @2x, for tools that need an icns                                         |
| `trayTemplate.svg`                        | Menu-bar template master, black on transparent                                                          |
| `trayTemplate.png`, `trayTemplate@2x.png` | 22 and 44 px renders; macOS tints files named `*Template`                                               |

Other copies of the icon: `apps/docs/app/icon.svg` and `apps/docs/public/logo.svg` (the flat SVG), `apps/docs/app/apple-icon.png`, and the web build's home-screen icons in `apps/desktop/src/renderer/web-public/icons/`. The mobile app has no icon of its own yet.

electron-builder compiles `icon.icon` with Xcode 26's `actool` into `Assets.car`. That gives macOS 26 the Liquid Glass icon with its default, dark and tinted appearances. electron-builder also derives the bundle's icns from it. `build/mac-icon.cjs` checks `xcodebuild -version` first. Below Xcode 26, or with only the Command Line Tools, it points `mac.icon` at the committed `icon.icns`. That build shows the same static icon on every macOS version, without the macOS 26 Liquid Glass, dark and tinted appearances. The release and package workflows require Xcode 26.

### Construction

- The grid is Apple's macOS grid: a 1024 px canvas and an 824 px body at (100, 100). In the `.icon` bundle the layers are drawn full-bleed on 1024, and the system applies the squircle. The numbers below are on that 1024 canvas.
- The o is 604 px wide, 59% of the canvas. Its height is 87.3% of its width (527 px). It sits 4 px below centre.
- The stroke is 17% of the o's width (103 px). Corners are square, with no rounding.
- The flap is a triangle on the counter's top edge, pointing down. Before the gap its corners sit in the counter's top corners and its tip at 46% of the counter's height.
- The `gap` parameter (10 px) shrinks the flap so it stays a piece of its own: the tip rises by `gap / cos(slope)`, 12.5 px, and the top corners move in by 1.2 times that. The flap's top edge still lies on the o's inner edge. Each glass piece draws its own edge, which reads as a hairline between them. The flap layer has 94% opacity.
- The 16 and 32 px slots use `icon-small.icon`: a 676 px o (66%), a 23% stroke, a 54% flap and a 22 px gap. At those sizes the hairline disappears and the flap reads as the V of an envelope.
- The menu-bar glyph is 18 x 15 pt on a 22 pt canvas. It has a 3 pt frame and edges on whole points. It draws the flap joined to the frame, since the hairline between the pieces would be thinner than a point.

### Colour

| Part       | Value                                                                            |
| ---------- | -------------------------------------------------------------------------------- |
| Background | vertical gradient `#34363D` to `#111215`; dark appearance `#1A1B1F` to `#050506` |
| Mark       | `#FFFFFF`, Liquid Glass, specular on, 10% translucency, neutral shadow at 50%    |

The `.icon` sets the light and dark fills explicitly. Clear and tinted come from the system.

### Development and preview icons

Both keep the production mark and groups and replace the background with drafting paper: 32 px and 128 px paper lines plus Apple's icon template grid (three circles, three squares, the diagonals and the centre lines). Neither carries text. Each `.icon` has a paper per appearance: light, dark, and a mono paper for clear and tinted, which keep only luminance.

| Icon        | Light                                                                                               | Dark                                                            | Clear and tinted                            |
| ----------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| Development | white paper `#FFFFFF` to `#F2F3F5`, black lines and grid; the mark in ink `#1C1C1E`, no drop shadow | dark grey paper `#2A2C31` to `#1A1B1F`, white lines; white mark | a dark wash with the grid alone; white mark |
| Preview     | Xcode's blueprint `#0CC0FB` to `#196EFA`, white lines and grid; white mark                          | `#0A5FA8` to `#0B3A8C`; white mark                              | dense bright lines and the grid; white mark |

The preview colours are sampled from Xcode.app's 1024 px icon, Apple's own blueprint. The layout follows the Figma community file "Debug icon kit (blueprint)" by mikan (CC BY 4.0). Unpackaged runs use the development icon. The preview icon is for a future preview channel: today every release, signed or unsigned, ships the same `app.openmail.desktop` build, and the in-app update channel ("latest" or "stable") changes what the updater downloads, not the installed bundle. A preview build with its own bundle id would package `icon-preview.icon` as its `mac.icon`.

### Regenerating

```sh
node docs/design/icon-source/icons.mjs     # geometry -> the four .icon bundles, icon.svg and the docs site's SVGs
sh apps/desktop/build/render-icons.sh      # -> icon.png, icon-dev.png, icon-preview.png, icon.icns, trayTemplate*.png, web and docs PNGs
```

The parameters are `MARK`, `MARK_SMALL` and `PAPERS` in `icons.mjs`. It has no dependencies and writes only SVG layers and `icon.json`. `node docs/design/icon-source/icons.mjs --out <dir>` writes the bundles and `icon.svg` to a scratch directory instead. `render-icons.sh` needs Xcode 26 (Icon Composer's `ictool`), Pillow and `rsvg-convert`; `render-icons.sh dev` renders only `icon-dev.png` and `icon-preview.png`.

To check a change, render each bundle in every appearance and look at the images, including 16 and 32 px:

```sh
ictool="/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
for r in Default Dark ClearLight ClearDark TintedLight TintedDark; do
  "$ictool" apps/desktop/build/icon.icon --export-image --output-file "/tmp/icon-$r.png" \
    --platform macOS --rendition "$r" --width 512 --height 512 --scale 1
done
```

## Provider icons

`apps/desktop/src/renderer/src/ui/ProviderIcon.tsx` imports brand marks from Iconify icon packages through `unplugin-icons`. The build compiles each used icon into a React component, so the app ships only these six and never fetches icons at runtime.

| Provider | Icon                        | Package                      | License   |
| -------- | --------------------------- | ---------------------------- | --------- |
| gmail    | `logos:google-gmail`        | `@iconify-json/logos`        | CC0-1.0   |
| outlook  | `selfhst:microsoft-outlook` | `@iconify-json/selfhst`      | CC-BY-4.0 |
| icloud   | `selfhst:icloud`            | `@iconify-json/selfhst`      | CC-BY-4.0 |
| yahoo    | `selfhst:yahoo`             | `@iconify-json/selfhst`      | CC-BY-4.0 |
| fastmail | `selfhst:fastmail`          | `@iconify-json/selfhst`      | CC-BY-4.0 |
| qq       | `thesvg-color:qq`           | `@iconify-json/thesvg-color` | MIT       |
| 163      | Red tile with "163", drawn  | none                         | Project   |
| imap     | Lucide `Mail`               | `lucide-react`               | ISC       |

selfh.st icons (CC-BY-4.0) need attribution: "Icons by selfh.st, https://selfh.st/icons". It goes in the app's About panel and in the README.

No open icon set has NetEase Mail's mark, so 163 uses a red tile with the number, like its app icon.

Brand marks are the trademarks of their owners and appear only to identify the provider an account belongs to.
