# Icons

## App icon

Masters live in `apps/desktop/build/`:

| File                                      | Use                                                              |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `icon.svg`                                | Master for 64 px and up                                          |
| `icon-small.svg`                          | 16 and 32 px slots: wider stripes, heavier flap line             |
| `icon.png`                                | 1024 px render; dock icon in dev, window icon on other platforms |
| `icon.icns`                               | macOS bundle icon, all sizes 16 to 512 at @1x and @2x            |
| `trayTemplate.svg`                        | Menu-bar template master, black on transparent                   |
| `trayTemplate.png`, `trayTemplate@2x.png` | 16 and 32 px renders; macOS tints files named `*Template`        |

Run `apps/desktop/build/render-icons.sh` after editing an SVG. It needs `rsvg-convert` (`brew install librsvg`) and `iconutil`, which ships with macOS.

The art follows Apple's macOS icon grid. The canvas is 1024 px. The body is 824 px at (100, 100) with continuous corners (straight edges, superellipse corners with n = 3.2 over 260 px) and a 10 px drop shadow. The body is an accent-blue gradient. The subject is a white envelope with a white rim, an airmail stripe band in `#D23A3A` and `#1F4FD1`, and a grey flap. The rim keeps the blue stripes from merging into the blue body.

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
