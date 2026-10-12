import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vitest";
import {
  type AppHistory,
  historyAtom,
  locationAtom,
  locationOf,
  rememberedViewsAtom,
  syncLocationAtom,
} from "./location";
import {
  commitSearchAtom,
  openMessageAtom,
  openThreadAtom,
  searchAtom,
  searchScopeAtom,
  searchTextAtom,
  viewAtom,
} from "./ui";

function setup(href = "/mail/all/inbox") {
  const calls: [string, boolean][] = [];
  const history: AppHistory = {
    navigate: (to, replace) => calls.push([to, replace]),
    back: vi.fn(),
    forward: vi.fn(),
  };
  const registry = AtomRegistry.make({
    initialValues: [
      [locationAtom, locationOf(href)],
      [historyAtom, history],
    ],
  });
  return { registry, calls };
}

it("derives the view from the route and pushes a new view", () => {
  const { registry, calls } = setup("/mail/work/sent?thread=t&q=hi&dialog=help");
  const view = registry.get(viewAtom);
  expect(view).toEqual({ space: "work", mailbox: "sent" });
  // A route change that keeps the view keeps the same view object.
  registry.set(syncLocationAtom, "/mail/work/sent?q=hi");
  expect(registry.get(viewAtom)).toBe(view);
  registry.set(viewAtom, { space: "all", mailbox: "inbox", accountId: "a" });
  expect(calls).toEqual([["/mail/all/inbox?account=a&q=hi", false]]);
  expect(registry.get(viewAtom)).toEqual({ space: "all", mailbox: "inbox", accountId: "a" });
  expect([...registry.get(rememberedViewsAtom).keys()]).toEqual(["work", "all"]);
  // The same view again only closes the thread, in place.
  registry.set(syncLocationAtom, "/mail/all/inbox?account=a&thread=x");
  registry.set(viewAtom, { space: "all", mailbox: "inbox", accountId: "a" });
  expect(calls.at(-1)).toEqual(["/mail/all/inbox?account=a", true]);
});

it("keeps typing local until the search is committed, and follows the route after Back", () => {
  const { registry, calls } = setup();
  registry.set(searchTextAtom, "from:alice ");
  expect(registry.get(searchAtom)).toBe("from:alice");
  expect(calls).toEqual([]);
  registry.set(commitSearchAtom, undefined);
  expect(calls).toEqual([["/mail/all/inbox?q=from%3Aalice", true]]);
  // The trailing space survives the commit.
  expect(registry.get(searchTextAtom)).toBe("from:alice ");
  registry.set(searchScopeAtom, "folder");
  expect(calls.at(-1)).toEqual(["/mail/all/inbox?q=from%3Aalice&scope=folder", true]);
  registry.set(syncLocationAtom, "/mail/all/inbox?q=bob");
  expect(registry.get(searchTextAtom)).toBe("bob");
  expect(registry.get(searchScopeAtom)).toBe("all");
});

it("never turns thread or compose windows into the mail view", () => {
  const { registry, calls } = setup("/thread/x");
  expect(registry.get(viewAtom)).toEqual({ space: "all", mailbox: "inbox" });
  registry.set(viewAtom, { space: "all", mailbox: "sent" });
  registry.set(searchScopeAtom, "folder");
  expect(calls).toEqual([]);
  expect(registry.get(locationAtom).href).toBe("/thread/x");
});

it("replaces the open thread and drops the message picked in the previous one", () => {
  const { registry, calls } = setup("/mail/all/inbox?thread=a&message=m");
  expect(registry.get(openThreadAtom)).toBe("a");
  expect(registry.get(openMessageAtom)).toBe("m");
  registry.set(openThreadAtom, "b");
  expect(calls).toEqual([["/mail/all/inbox?thread=b", true]]);
  expect(registry.get(openMessageAtom)).toBeNull();
  registry.set(openMessageAtom, "n");
  expect(calls.at(-1)).toEqual(["/mail/all/inbox?thread=b&message=n", true]);
  registry.set(openThreadAtom, null);
  expect(registry.get(locationAtom).href).toBe("/mail/all/inbox");
});
