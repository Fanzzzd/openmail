import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { ApiError } from "../provider-http.js";
import { uncertainWrite } from "../provider-retry.js";

import type { Account } from "../../domain/account.js";
import type { MailOp } from "../../domain/changes.js";
import { PermanentError, ProviderError } from "../../domain/errors.js";
import type { ProviderAdapter } from "../adapter.js";

import { writeFailure, API } from "./api.js";
import type { GmailClient } from "./client.js";

/** Label changes on messages (push) and on the label list itself (changeLabel). */
export const makeGmailLabels = (client: GmailClient) => {
  const { api, get, post, del, fetchUserLabels } = client;
  const push = Effect.fn("Gmail.push")(
    function* (account: Account, providerId: string, op: MailOp) {
      if (op.kind === "categories" || op.kind === "classification" || op.kind === "copy")
        yield* new PermanentError({
          message: "This organization action is unavailable for Gmail.",
        });
      const path = `/messages/${encodeURIComponent(providerId)}`;
      let untrashed = false;
      if (op.kind === "trash") {
        yield* post(account.id, `${path}/trash`);
        return;
      }
      if (op.kind === "inbox") {
        // Untrash restores the labels the message had before trashing; the
        // modify below then makes sure it lands in the inbox.
        yield* post(account.id, `${path}/untrash`);
      }
      if (op.kind === "move" && op.labelId !== "TRASH") {
        const current = yield* get(
          account.id,
          Schema.Struct({ labelIds: Schema.optionalKey(Schema.Array(Schema.String)) }),
          `${path}?format=minimal`,
        );
        if (current.labelIds?.includes("TRASH")) {
          // Validate before changing Trash membership. System destinations are fixed.
          if (
            !/^(INBOX|ARCHIVE|SPAM|SENT|DRAFT|STARRED|IMPORTANT|CATEGORY_[A-Z]+)$/.test(op.labelId)
          ) {
            const labels = yield* fetchUserLabels(account.id);
            if (!labels.some((label) => label.id === op.labelId))
              yield* new PermanentError({
                message: "The destination label no longer exists",
              });
          }
          yield* post(account.id, `${path}/untrash`);
          untrashed = true;
        }
      }
      const { add, remove } = gmailDelta(op);
      yield* post(account.id, `${path}/modify`, { addLabelIds: add, removeLabelIds: remove }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (untrashed) {
              const restored = yield* post(account.id, `${path}/trash`).pipe(Effect.result);
              if (restored._tag === "Failure")
                return yield* new ProviderError({
                  message:
                    "Move failed after removing Trash. Restoring Trash also failed; check the message location.",
                });
            }
            return yield* Effect.fail(error);
          }),
        ),
      );
    },
    (effect, account) => Effect.mapError(effect, writeFailure(account.id)),
  );

  const changeLabel: ProviderAdapter["changeLabel"] = (account, change) =>
    Effect.gen(function* () {
      if (change.kind === "create") {
        const current = yield* fetchUserLabels(account.id);
        const parent = current.find((l) => l.id === change.parentId)?.name;
        const name = parent ? `${parent}/${change.name}` : change.name;
        if (current.some((label) => label.name.toLowerCase() === name.toLowerCase()))
          return current;
        yield* post(account.id, "/labels", {
          name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        }).pipe(
          Effect.catchIf(
            (error) =>
              error._tag === "ApiError" &&
              (error.status === 400 || error.status === 409 || uncertainWrite(error)),
            (error) =>
              Effect.gen(function* () {
                const labels = yield* fetchUserLabels(account.id);
                if (!labels.some((label) => label.name.toLowerCase() === name.toLowerCase()))
                  yield* Effect.fail(error);
              }),
          ),
        );
      } else if (change.kind === "delete")
        yield* del(account.id, `/labels/${encodeURIComponent(change.id)}`);
      else if (change.kind === "parent") {
        const labels = yield* fetchUserLabels(account.id);
        const old = labels.find((l) => l.id === change.id);
        const parent = labels.find((l) => l.id === change.parentId);
        if (old) {
          const name = `${parent ? `${parent.name}/` : ""}${old.name.split("/").at(-1)}`;
          const moving = labels.filter(
            (candidate) => candidate.id === old.id || candidate.name.startsWith(`${old.name}/`),
          );
          const planned = moving.map((label) => ({
            label,
            name: name + label.name.slice(old.name.length),
          }));
          const otherNames = new Set(
            labels
              .filter((label) => !moving.some((item) => item.id === label.id))
              .map((label) => label.name.toLowerCase()),
          );
          if (planned.some((item) => otherNames.has(item.name.toLowerCase())))
            return yield* new ApiError({
              status: 400,
              body: "A label with the destination name already exists",
            });
          const patchName = (id: string, labelName: string) =>
            api(
              account.id,
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.patch(`${API}/labels/${encodeURIComponent(id)}`),
                { name: labelName },
              ),
            );
          const renamed: typeof moving = [];
          for (const item of planned) {
            const result = yield* patchName(item.label.id, item.name).pipe(Effect.result);
            if (result._tag === "Failure") {
              let rollbackFailed = false;
              for (const previous of renamed.toReversed()) {
                const rollback = yield* patchName(previous.id, previous.name).pipe(Effect.result);
                rollbackFailed ||= rollback._tag === "Failure";
              }
              if (rollbackFailed)
                return yield* new ApiError({
                  status: 500,
                  body: "Moving the label failed and rollback was incomplete. Reload the labels before trying again.",
                });
              return yield* result.failure;
            }
            renamed.push(item.label);
          }
        }
      } else {
        const body =
          change.kind === "visibility"
            ? {
                labelListVisibility: change.labelListVisibility,
                messageListVisibility: change.messageListVisibility,
              }
            : change.kind === "rename"
              ? { name: change.name }
              : { color: { backgroundColor: change.color ?? "#ffffff", textColor: "#000000" } };
        yield* api(
          account.id,
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.patch(`${API}/labels/${encodeURIComponent(change.id)}`),
            body,
          ),
        );
      }
      return yield* fetchUserLabels(account.id);
    }).pipe(Effect.mapError(writeFailure(account.id)));

  return { push, changeLabel };
};

export function gmailDelta(op: MailOp): { add: string[]; remove: string[] } {
  switch (op.kind) {
    case "read":
      return op.value ? { add: [], remove: ["UNREAD"] } : { add: ["UNREAD"], remove: [] };
    case "star":
      return op.value ? { add: ["STARRED"], remove: [] } : { add: [], remove: ["STARRED"] };
    case "important":
      return op.value ? { add: ["IMPORTANT"], remove: [] } : { add: [], remove: ["IMPORTANT"] };
    case "archive":
      return { add: [], remove: ["INBOX"] };
    case "inbox":
      return { add: ["INBOX"], remove: ["SPAM"] };
    case "trash":
      return { add: ["TRASH"], remove: [] };
    case "spam":
      return { add: ["SPAM"], remove: ["INBOX"] };
    case "move":
      return {
        add: [op.labelId],
        remove: [
          ...new Set([
            ...(op.removeLabelId && op.removeLabelId !== op.labelId && op.removeLabelId !== "TRASH"
              ? [op.removeLabelId]
              : []),
            ...(op.labelId !== "SPAM" ? ["SPAM"] : []),
          ]),
        ],
      };
    case "label":
      return op.value ? { add: [op.labelId], remove: [] } : { add: [], remove: [op.labelId] };
    case "classification":
    case "categories":
    case "copy":
      return { add: [], remove: [] };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}
