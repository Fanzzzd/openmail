import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fakeMessage, runElectron, serveWebApp, webRoot } from "./test-support/web-app-harness";
import { scaledMs } from "../../../../../packages/core/test-support/test-time.js";

/**
 * The built web app on a phone (390 px, touch) in Electron's Chromium, behind
 * the stand-in for Tailscale Serve, with fake mail: the home-screen manifest
 * and safe areas, Back from the reader, a dropped connection mid-reply, and
 * the page a login outside the allowlist gets.
 */
const driver = path.join(import.meta.dirname, "phone-web-driver.cjs");

interface Seen {
  subject: string | null;
  samePage: boolean;
}
interface Result {
  loaded: boolean;
  head: {
    colorScheme: string[];
    themeColors: number;
    manifest: { name: string; display: string; icons: { src: string; sizes: string }[] };
    icons: { href: string; status: number; type: string }[];
  };
  safeAreaEmulated: boolean;
  safeArea: {
    firstRowTop: number;
    firstRowPadTop: string;
    secondRowPadTop: string | null;
    cssInsets: string[];
  };
  drawer: { padBottom: string; firstRowPadTop: string; compose: { w: number; h: number } };
  drawerClosed: boolean;
  readerOpened: boolean;
  readerPadTop: string;
  composer: { borderTop: string; borderBottom: string; sendBottom: number };
  composerKeyboard: { sheetBottom: number; borderBottom: string; sendBottom: number };
  backToList: boolean;
  afterBack: string;
  composerOpened: boolean;
  lostShown: boolean;
  whileDown: Seen;
  reconnected: boolean;
  saved: boolean;
  afterReconnect: Seen;
  forbidden: { title: string; text: string; scripts: number };
}

// Skips without `pnpm build`, except under CI, where a missing web build fails.
it.skipIf(!process.env.CI && !existsSync(path.join(webRoot, "web.html")))(
  "works as a phone app: home screen, safe areas, Back, reconnecting and the login page",
  { timeout: scaledMs(180_000) },
  async () => {
    const app = await serveWebApp([
      fakeMessage("1", "Quarterly report draft", "Dana Whitfield", 5),
      fakeMessage("2", "Lunch on Friday?", "Sam Ortiz", 45),
    ]);
    const work = mkdtempSync(path.join(tmpdir(), "openmail-phone-web-"));
    const out = path.join(work, "out.json");
    let result: Result;
    // Set OPENMAIL_PHONE_WEB_DEBUG=1 to print what the driver saw.
    try {
      expect(await runElectron(driver, [app.url, out], work)).toBe(0);
      // IO boundary: JSON written by the driver.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON written by the driver
      result = JSON.parse(readFileSync(out, "utf8")) as Result;
      if (process.env.OPENMAIL_PHONE_WEB_DEBUG) console.log(JSON.stringify(result, null, 2));
    } finally {
      await app.close();
      rmSync(work, { recursive: true, force: true });
    }
    expect(result.loaded).toBe(true);

    // Add to Home Screen gets a name and icons; the browser chrome follows light and dark.
    expect(result.head.colorScheme).toEqual(["light dark"]);
    expect(result.head.themeColors).toBe(2);
    expect(result.head.manifest).toMatchObject({ name: "OpenMail", display: "standalone" });
    expect(result.head.manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    expect(result.head.icons).toHaveLength(3);
    for (const icon of result.head.icons)
      expect(icon, icon.href).toMatchObject({ status: 200, type: "image/png" });

    // The title rows, drawer and composer clear the notch and the home indicator.
    expect(result.safeArea.cssInsets).toEqual(["top", "bottom", "left", "right"]);
    expect(result.safeArea.firstRowTop).toBe(0);
    expect(result.drawerClosed).toBe(true);
    expect(result.drawer.compose.w).toBeGreaterThanOrEqual(44);
    expect(result.drawer.compose.h).toBeGreaterThanOrEqual(44);
    if (result.safeAreaEmulated) {
      expect(result.safeArea.firstRowPadTop).toBe("47px");
      // The list's title under its search field is not the top of the screen.
      expect(result.safeArea.secondRowPadTop ?? "0px").toBe("0px");
      expect(result.drawer).toMatchObject({ padBottom: "34px", firstRowPadTop: "47px" });
      expect(result.readerPadTop).toBe("47px");
      expect(result.composer).toMatchObject({ borderTop: "47px", borderBottom: "34px" });
      expect(result.composer.sendBottom).toBeLessThanOrEqual(844 - 34);
    }
    // With the keyboard up, the composer ends at the keyboard and Send stays above it.
    expect(result.composerKeyboard.sheetBottom).toBe(844 - 300);
    expect(result.composerKeyboard.borderBottom).toBe("0px");
    expect(result.composerKeyboard.sendBottom).toBeLessThanOrEqual(844 - 300);

    // Back (or the iOS edge swipe) closes the reader and stays in the app.
    expect(result.readerOpened).toBe(true);
    expect(result.backToList).toBe(true);
    expect(result.afterBack).toMatch(/^\/mail\//);

    // A dropped connection keeps the page and the typing, reconnects in place,
    // and the draft saved while it was down reaches the Mac.
    expect(result.composerOpened).toBe(true);
    expect(result.lostShown).toBe(true);
    expect(result.whileDown).toEqual({ subject: "Typed before the drop", samePage: true });
    expect(result.reconnected).toBe(true);
    expect(result.afterReconnect).toEqual({ subject: "Typed before the drop", samePage: true });
    expect(result.saved).toBe(true);

    // A login outside the allowlist learns which login the Mac saw and where to add it.
    expect(result.forbidden.scripts).toBe(0);
    expect(result.forbidden.title).toBe("This login can't open OpenMail");
    expect(result.forbidden.text).toContain("intruder@github");
    expect(result.forbidden.text).toContain("Settings → Remote access");
  },
);
