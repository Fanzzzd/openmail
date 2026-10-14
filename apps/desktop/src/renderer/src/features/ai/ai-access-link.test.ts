import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { setPlatform } from "../../lib/platform";
import { AiAccessLink } from "./AiPanel";

afterEach(() => setPlatform("desktop"));

const render = () =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
      createElement(AiAccessLink),
    ),
  );

it("the Mac links to AI Access; the web build, which has no such tab, says where to set AI up", () => {
  expect(render()).toContain("<button");
  expect(render()).toContain("Open AI Access");
  setPlatform("web");
  const web = render();
  expect(web).not.toContain("<button");
  expect(web).not.toContain("Open AI Access");
  expect(web).toContain("Set up AI on your Mac in Settings → AI Access.");
});
