import {
  AppleContactsSnapshot,
  AppleContactsStatus,
  createAppleContactsCache,
  type Prefs,
} from "@openmail/core/schema";
import { Schema } from "effect";

const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(AppleContactsSnapshot));
const decodeStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ status: AppleContactsStatus })),
);
export class ContactsPermissionTimeout extends Error {}
type Dependencies = {
  platform: string;
  prefs: () => Promise<Pick<Prefs, "useAppleContacts" | "contactPhotos">>;
  setEnabled: (enabled: boolean) => Promise<void>;
  execute: (args: string[]) => Promise<string>;
  now?: () => number;
};
type Job<A> = { generation: number; promise: Promise<A> };

/** Read paths use memory immediately. Only an explicit setting change requests access. */
export function createAppleContactsController(deps: Dependencies) {
  const cache = createAppleContactsCache();
  const now = deps.now ?? Date.now;
  let status: AppleContactsStatus = deps.platform === "darwin" ? "off" : "unsupported";
  let revision = 0;
  let epoch = 0;
  let checked = -Infinity;
  let refreshed = -Infinity;
  let photos = false;
  let hasSnapshot = false;
  let waitingForPermission = false;
  let authorizationJob: Job<AppleContactsStatus> | undefined;
  let snapshotJob: Job<void> | undefined;
  const clear = () => {
    cache.clear();
    if (hasSnapshot) revision++;
    hasSnapshot = false;
    refreshed = -Infinity;
  };
  const invalidate = () => {
    epoch++;
    checked = -Infinity;
    clear();
  };
  const configure = async () => {
    const prefs = await deps.prefs();
    if (deps.platform !== "darwin" || !prefs.useAppleContacts) {
      if (status !== "off" && status !== "unsupported") invalidate();
      waitingForPermission = false;
      status = deps.platform === "darwin" ? "off" : "unsupported";
      return false;
    }
    if (photos !== prefs.contactPhotos) {
      if (!prefs.contactPhotos) {
        cache.discardPhotos();
        if (hasSnapshot) revision++;
      }
      photos = prefs.contactPhotos;
      refreshed = -Infinity;
    }
    return true;
  };
  const setAuthorization = (value: AppleContactsStatus) => {
    if (value !== "notDetermined") waitingForPermission = false;
    status = value === "notDetermined" && waitingForPermission ? "waiting" : value;
    if (value !== "authorized" && value !== "limited") clear();
    return status;
  };
  const checkAuthorization = (): Promise<AppleContactsStatus> => {
    if (authorizationJob?.generation === epoch) return authorizationJob.promise;
    if (now() - checked < 10_000) return Promise.resolve(status);
    const generation = epoch;
    checked = now();
    const promise = (async () => {
      try {
        const authorization = decodeStatus(await deps.execute(["--status"])).status;
        if (generation !== epoch) return status;
        if (!(await configure()) || generation !== epoch) return status;
        return setAuthorization(authorization);
      } catch {
        if (generation === epoch) {
          clear();
          status = "error";
        }
        return status;
      } finally {
        if (authorizationJob?.generation === generation) authorizationJob = undefined;
      }
    })();
    authorizationJob = { generation, promise };
    return promise;
  };
  const readable = () => status === "authorized" || status === "limited";
  const refreshSnapshot = () => {
    if (!readable() || snapshotJob?.generation === epoch || now() - refreshed < 60_000) return;
    const generation = epoch;
    const includePhotos = photos;
    // Bound retries even on malformed helper output.
    refreshed = now();
    const promise = (async () => {
      try {
        const snapshot = decodeSnapshot(
          await deps.execute(includePhotos ? ["--read", "--photos"] : ["--read"]),
        );
        const prefs = await deps.prefs();
        if (generation !== epoch) return;
        if (!prefs.useAppleContacts) {
          invalidate();
          waitingForPermission = false;
          status = "off";
          return;
        }
        // A denial observed by --status must win over an earlier in-flight snapshot.
        if (!readable()) return;
        setAuthorization(snapshot.status);
        cache.replace(snapshot, prefs.contactPhotos && includePhotos);
        hasSnapshot = "contacts" in snapshot;
        revision++;
        if (photos !== prefs.contactPhotos) refreshed = -Infinity;
      } catch {
        if (generation === epoch) {
          clear();
          status = "error";
        }
      } finally {
        if (snapshotJob?.generation === generation) snapshotJob = undefined;
      }
    })();
    snapshotJob = { generation, promise };
  };
  const poll = async () => {
    if (await configure()) {
      await checkAuthorization();
      refreshSnapshot();
    }
    return { status, revision };
  };
  return {
    cache,
    invalidate,
    poll,
    async read(): Promise<AppleContactsStatus> {
      if (await configure()) {
        void checkAuthorization().then(() => refreshSnapshot());
      }
      return status;
    },
    async refresh() {
      // Retain the usable snapshot while a replacement loads in the background.
      epoch++;
      checked = -Infinity;
      refreshed = -Infinity;
      return poll();
    },
    async setEnabled(enabled: boolean): Promise<AppleContactsStatus> {
      invalidate();
      waitingForPermission = false;
      status = deps.platform === "darwin" ? "off" : "unsupported";
      await deps.setEnabled(enabled);
      if (!enabled || deps.platform !== "darwin") {
        invalidate();
        return (status = deps.platform === "darwin" ? "off" : "unsupported");
      }
      const generation = epoch;
      waitingForPermission = true;
      status = "waiting";
      try {
        const authorization = decodeStatus(await deps.execute(["--request"])).status;
        if (generation !== epoch) return status;
        const enabledNow = await configure();
        if (!enabledNow || generation !== epoch) return status;
        checked = now();
        setAuthorization(authorization);
        refreshSnapshot();
      } catch (error) {
        if (generation === epoch) {
          clear();
          waitingForPermission = error instanceof ContactsPermissionTimeout;
          status = waitingForPermission ? "waiting" : "error";
          checked = -Infinity;
        }
      }
      return status;
    },
  };
}

/** Legacy Contacts deep links preserve the record separator, and accept no URL syntax. */
export function appleContactUrl(identifier: string) {
  if (
    !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?::ABPerson)?$/.test(
      identifier,
    )
  )
    throw new Error("Invalid contact identifier");
  return `addressbook://${identifier}`;
}
