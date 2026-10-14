# Letter avatar colors

Reader letter avatars use a fixed palette of darker Google Material tones with
at least 4.5:1 contrast against their white text:
`#c62828`, `#ad1457`, `#7b1fa2`, `#512da8`, `#303f9f`, `#3367d6`,
`#1565c0`, `#00695c`, `#2e7d32`, `#a65a00`, `#bf360c`, `#6d4c41`.

Normalize the display name to Unicode NFC, trim it, and lowercase it with
`toLowerCase()` so the result does not depend on the device locale. When the
sender has no name, use the email address. Starting at zero, fold each UTF-16
code unit with `hash = (hash * 31 + codeUnit) >>> 0`. Select
`palette[hash % palette.length]`. The same name keeps its color after a restart.
Contact photos take precedence. Account and profile colors keep their own settings.

The palette gives Gmail-like tones. Gmail does not publish its contact-to-color
mapping; this algorithm does not claim exact parity with a Gmail account's avatar.
The implementation is in `apps/desktop/src/renderer/src/lib/format.ts`, with golden
values and normalization cases in `format-avatar.test.ts`.

The reference is Google's [Material color system](https://m2.material.io/design/color/the-color-system.html),
not a published Gmail identity hash. Most tones above are Material 800/900;
`#3367d6` retains the Google blue and `#a65a00` darkens amber for white-text contrast.
These choices favor the documented Google hue families within the existing 4.5:1
contrast requirement. No authenticated Gmail screenshots or sender-color samples
were available when the palette was chosen, so the mapping remains an approximation.
