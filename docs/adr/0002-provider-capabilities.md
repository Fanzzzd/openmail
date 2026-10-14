# 0002 Provider capabilities

Status: accepted.

## Context

Code outside `packages/core/src/providers` and `platform` compared provider names 265 times in 76 files. Several layers wrote the same rule. "Gmail uses labels, the others use folders" appeared in `mailbox-batch.ts`, `ThreadActions.tsx`, `BatchActions.tsx` and the mobile thread actions. Outlook's 1024-byte rule size step sat in `mailbox-filters.ts` and again in `FilterEditor.tsx`. When one copy changed and another did not, the UI could show an action that core then rejected. Adding a provider meant editing every one of those files.

## Decision

`providers/capabilities.ts` holds one table, `providerCapabilities(provider)`, with a field per question callers ask. It is plain data with no Node imports, exported from `@openmail/core`, `@openmail/core/schema` and `@openmail/core/portable`. `supportsOp(capabilities, kind)` answers whether an account can run an op kind. `labelOpMoves` answers whether a label op moves the message. `oauthProvider` and `signsInWithOAuth` narrow types for OAuth-only code.

Core validation reads the table. The renderer, the CLI and mobile read the same table instead of the provider name. Core's batch gate and the toolbar both call `supportsOp`, and `capabilities.test.ts` checks that core rejects exactly the ops the UI hides.

The renderer calls `providerCapabilities(account.provider)` on account data it already has. The table is not a field on `Account`. The value depends only on the provider, so a field would copy it into every row, every RPC payload and every test fixture.

Rules:

- Outside `providers/` and `platform/`, do not compare `provider` with a name to decide what an account can do. Read a capability, or add a field named for the question.
- Brand names in copy, provider icons, OAuth client choice and e2e fixtures may use the name. `provider-names.test.ts` lists those files.
- Protocol detail still outside the adapters keeps a per-file count in `provider-names.test.ts`, for example ID formats, cursor layout, endpoint choice, size limits and sync-health budgets. Lower the count when code moves into an adapter. Never raise it.

## Consequences

- 53 comparisons remain outside `providers/` and `platform/`, plus 20 identity uses. All are listed in `provider-names.test.ts`.
- A new provider adds one row to the table. The remaining protocol comparisons still need a look.
- The native menu enables Mark important only for Gmail through its `gmail` flag, while the toolbar offers it for Outlook too. This change keeps that behaviour, and the guard counts both comparisons.
