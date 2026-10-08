import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vitest";
import {
  IMAGES_LOADED_LIMIT,
  MESSAGE_BACKGROUND_LIMIT,
  imagesLoadedAtom,
  messageBackgroundAtom,
  remember,
} from "./ui";

describe("remember", () => {
  it("drops the oldest keys past the limit and refreshes a key that is set again", () => {
    let map: ReadonlyMap<string, number> = new Map();
    for (const key of ["a", "b", "c"]) map = remember(map, key, 1, 3);
    map = remember(map, "a", 2, 3);
    map = remember(map, "d", 1, 3);
    expect([...map.keys()]).toEqual(["c", "a", "d"]);
    expect(map.get("a")).toBe(2);
    expect([...remember(map, "c", undefined, 3).keys()]).toEqual(["a", "d"]);
  });
});

describe("reader session choices", () => {
  it("keep an image-load decision while the thread stays open and after other threads", () => {
    const registry = AtomRegistry.make();
    const open = imagesLoadedAtom("thread-open");
    const release = registry.mount(open);
    registry.set(open, new Set(["m1", "m2"]));
    for (let i = 0; i < IMAGES_LOADED_LIMIT - 1; i++)
      registry.set(imagesLoadedAtom(`other-${i}`), new Set([`x${i}`]));
    expect([...registry.get(open)]).toEqual(["m1", "m2"]);
    // A fresh family member reads the same stored decision.
    expect([...registry.get(imagesLoadedAtom("thread-open"))]).toEqual(["m1", "m2"]);
    release();
    expect(registry.get(imagesLoadedAtom("never-set")).size).toBe(0);
  });

  it("forget the oldest image-load decisions past the limit", () => {
    const registry = AtomRegistry.make();
    for (let i = 0; i <= IMAGES_LOADED_LIMIT; i++)
      registry.set(imagesLoadedAtom(`thread-${i}`), new Set([`m${i}`]));
    expect(registry.get(imagesLoadedAtom("thread-0")).size).toBe(0);
    expect([...registry.get(imagesLoadedAtom("thread-1"))]).toEqual(["m1"]);
    expect([...registry.get(imagesLoadedAtom(`thread-${IMAGES_LOADED_LIMIT}`))]).toEqual([
      `m${IMAGES_LOADED_LIMIT}`,
    ]);
  });

  it("keep message backgrounds up to the limit and notify mounted readers", () => {
    const registry = AtomRegistry.make();
    const seen: Array<"light" | "dark" | null> = [];
    const release = registry.subscribe(
      messageBackgroundAtom("first"),
      (value) => seen.push(value),
      {
        immediate: true,
      },
    );
    registry.set(messageBackgroundAtom("first"), "dark");
    expect(seen).toEqual([null, "dark"]);
    for (let i = 0; i < MESSAGE_BACKGROUND_LIMIT - 1; i++)
      registry.set(messageBackgroundAtom(`m${i}`), "light");
    expect(registry.get(messageBackgroundAtom("first"))).toBe("dark");
    // Setting a background again makes it the newest, so the next eviction takes another.
    registry.set(messageBackgroundAtom("first"), "light");
    registry.set(messageBackgroundAtom("new"), "dark");
    expect(registry.get(messageBackgroundAtom("first"))).toBe("light");
    expect(registry.get(messageBackgroundAtom("m0"))).toBeNull();
    // Back to the preference removes the entry.
    registry.set(messageBackgroundAtom("new"), null);
    expect(registry.get(messageBackgroundAtom("new"))).toBeNull();
    release();
  });
});
