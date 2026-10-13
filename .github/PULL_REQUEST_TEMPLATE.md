## What and why

<!-- What this changes and the problem it solves. Link the issue: Fixes #123 -->

## How I tested it

<!-- Commands you ran, and what you checked in the app. Screenshots for UI changes, without real mail. -->

## Checklist

- [ ] `pnpm build && pnpm check-types && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .` passes
- [ ] New UI strings are extracted and translated in all ten locales (see CONTRIBUTING.md)
- [ ] The change follows the architecture rules in CONTRIBUTING.md (core owns network and database, append-only migrations, tokens only in the keychain, read-only MCP by default)
- [ ] Docs are updated if behaviour or setup changed
