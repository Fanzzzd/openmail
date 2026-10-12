// @vitest-environment jsdom
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, it, vi } from "vitest";
import { createAppRouter } from "./router";

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
