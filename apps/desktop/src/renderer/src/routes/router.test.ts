// @vitest-environment jsdom
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, it, vi } from "vitest";
import { createAppHashHistory } from "./hash-history";
import { createAppRouter, historyFor } from "./router";

vi.mock("../app/App", () => ({ App: () => null }));
vi.mock("../app/ThreadWindow", () => ({ ThreadWindow: () => null }));

async function load(href: string, defaultHref?: () => string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [href] }), defaultHref);
  await router.load();
  const match = router.state.matches.at(-1);
  return { router, href: router.history.location.href, match };
}

it("redirects the index to the default view", async () => {
  expect((await load("/")).href).toBe("/mail/all/inbox");
  expect((await load("/", () => "/mail/work/sent")).href).toBe("/mail/work/sent");
});

it("redirects an unknown mailbox to the space's inbox", async () => {
  expect((await load("/mail/work/nowhere?q=x")).href).toBe("/mail/work/inbox");
});

it("keeps valid search params and drops invalid ones", async () => {
  const { match } = await load(
    "/mail/all/inbox?q=from%3Aalice&scope=bogus&dialog=help&thread=123&extra=1",
  );
  expect(match?.routeId).toBe("/mail/$space/$mailbox");
  expect(match?.search).toMatchObject({
    q: "from:alice",
    scope: undefined,
    dialog: "help",
    thread: "123",
  });
});

it("decodes ids with slashes in path params", async () => {
  const { match } = await load("/thread/gmail%3Ame%40gmail.com%2Fone?single=1");
  expect(match?.routeId).toBe("/thread/$threadId");
  expect(match?.params).toEqual({ threadId: "gmail:me@gmail.com/one" });
  expect(match?.search).toMatchObject({ single: "1" });
});

it("routes compose windows", async () => {
  const { match } = await load("/compose/draft%3Aabc");
  expect(match?.params).toEqual({ draftId: "draft:abc" });
});

const settled = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
async function hashBecomes(hash: string) {
  for (let i = 0; i < 100 && window.location.hash !== hash; i++) await settled(5);
  expect(window.location.hash).toBe(hash);
}

/**
 * The window's real history: a browser Back, Forward or Go that lands while a replace waits to
 * settle drops the replace, so the timer does not write it over the entry the move landed on.
 */
it.each(["back", "forward", "go"] as const)(
  "a browser %s before a replace settles keeps the entry it lands on",
  async (move) => {
    window.history.replaceState(null, "", "/#/mail/all/inbox");
    const router = createAppRouter(createAppHashHistory());
    await router.load();
    const history = historyFor(router, 50);
    try {
      history.navigate("/mail/all/sent", false);
      await hashBecomes("#/mail/all/sent");
      if (move === "forward") {
        window.history.back();
        await hashBecomes("#/mail/all/inbox");
        history.navigate("/mail/all/inbox?thread=a", true);
        window.history.forward();
        await hashBecomes("#/mail/all/sent");
        await settled(150);
        expect(window.location.hash).toBe("#/mail/all/sent");
        expect(history.index()).toBe(1);
        return;
      }
      history.navigate("/mail/all/sent?thread=a", true);
      if (move === "back") window.history.back();
      else window.history.go(-1);
      await hashBecomes("#/mail/all/inbox");
      await settled(150);
      expect(window.location.hash).toBe("#/mail/all/inbox");
      expect(history.index()).toBe(0);
    } finally {
      router.history.destroy();
    }
  },
);
