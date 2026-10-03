# Icons

## App icon

The mark is the Flap o: a square o whose counter is an envelope, with the V fold hanging from the counter's top edge. It reads as the o of openmail and as mail, and stays an envelope at 32 px. The design rounds that led to it are in `docs/design/icon-options-v2/` (option R6-10, "Light").

Files in `apps/desktop/build/`:

| File                                      | Use                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `icon.icon`                               | Icon Composer master; `mac.icon` in electron-builder.config.cjs points here          |
| `icon-small.icon`                         | Heavier variant for the 16 and 32 px icns slots                                      |
| `icon.svg`                                | Flat vector version on the macOS grid, for places that cannot use the `.icon` bundle |
| `icon.png`                                | 1024 px Liquid Glass render; Dock and window icon in dev                             |
| `icon.icns`                               | All sizes 16 to 512 at @1x and @2x, for tools that need an icns                      |
| `trayTemplate.svg`                        | Menu-bar template master, black on transparent                                       |
| `trayTemplate.png`, `trayTemplate@2x.png` | 22 and 44 px renders; macOS tints files named `*Template`                            |

electron-builder compiles `icon.icon` with Xcode 26's `actool` into `Assets.car`. That gives macOS 26 the Liquid Glass icon with its default, dark and tinted appearances. electron-builder also derives the bundle's icns fallback from it, so packaging needs Xcode 26.

### Construction

- The grid is Apple's macOS grid: a 1024 px canvas and an 824 px body at (100, 100). In the `.icon` bundle the layers are drawn full-bleed on 1024, and the system applies the squircle.
- The o is 61.5% of the body wide. Its height is 87.3% of its width.
- The stroke is 17% of the o's width. Corners are square, with no rounding.
- The V fold hangs from the counter's top edge and reaches 44% of the counter's height. It is deeper than R6-10's 40% because the larger counter made the fold look shallow.
- The 16 and 32 px slots use `icon-small.icon`: a 23% stroke, a 50% V and a 66% width.
- The menu-bar glyph is 18 x 15 pt on a 22 pt canvas. It has a 3 pt frame and edges on whole points.

### Colour

| Part       | Value                                                 |
| ---------- | ----------------------------------------------------- |
| Background | vertical gradient `#26272C` to `#0E0E11`              |
| Mark       | `#FFFFFF`, Liquid Glass, specular on, 8% translucency |

The system derives the dark and tinted appearances.

### Regenerating

```sh
python3 docs/design/icon-options-v2/build6.py --final   # geometry -> icon.icon, icon-small.icon, icon.svg
sh apps/desktop/build/render-icons.sh                   # -> icon.png, icon.icns, trayTemplate*.png
pnpm exec oxfmt apps/desktop/build                       # the generator writes unformatted icon.json
```

The final parameters are `FINAL` and `FINAL_SMALL` in `build6.py`. `build6.py` needs `shapely` and Pillow. `render-icons.sh` needs Xcode 26 (Icon Composer's `ictool`), Pillow and `rsvg-convert`.

## Provider icons

`apps/desktop/src/renderer/src/components/ProviderIcon.tsx` imports brand marks from Iconify icon packages through `unplugin-icons`. The build compiles each used icon into a React component, so the app ships only these six and never fetches icons at runtime.

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
