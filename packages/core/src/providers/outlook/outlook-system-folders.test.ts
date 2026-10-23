import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { account, run } from "../../../test-support/outlook-fixtures.js";
import { SKIPPED, WELL_KNOWN } from "./graph.js";
import { SYSTEM_FOLDERS_TTL_MS } from "./sync.js";

const lookups = (http: ReturnType<typeof fakeHttp>) =>
  http.calls.filter((call) =>
    [...WELL_KNOWN.map((f) => f.name), ...SKIPPED].some(
      (name) => call.route === `GET /me/mailFolders/${name}`,
    ),
  ).length;

it.effect("system folders that 404 are not asked for again on every folder listing", () =>
  Effect.gen(function* () {
    // Only Inbox and Sent exist; archive, clutter, scheduled and the rest answer 404.
    const http = fakeHttp({
      "GET /me/mailFolders/inbox": { json: { id: "inbox-id" } },
      "GET /me/mailFolders/sentitems": { json: { id: "sent-id" } },
      "GET /me/mailFolders": {
        json: {
          value: [
            { id: "inbox-id", displayName: "Inbox", childFolderCount: 0, totalItemCount: 1 },
            { id: "work-id", displayName: "Work", childFolderCount: 0, totalItemCount: 1 },
          ],
        },
      },
    });
    const all = WELL_KNOWN.length + SKIPPED.length;
    yield* run(http, (adapter) =>
      Effect.gen(function* () {
        const create = { kind: "create" as const, name: "New" };
        const listed = () =>
          adapter.changeLabel(account, create).pipe(Effect.catch(() => Effect.void));
        yield* listed();
        assert.strictEqual(lookups(http), all);
        // Later listings in the same session reuse the answer, 404s included.
        yield* listed();
        yield* listed();
        assert.strictEqual(lookups(http), all);
        // After the TTL a folder created in the meantime is found.
        yield* TestClock.adjust(SYSTEM_FOLDERS_TTL_MS + 1);
        yield* listed();
        assert.strictEqual(lookups(http), 2 * all);
      }),
    );
  }),
);
