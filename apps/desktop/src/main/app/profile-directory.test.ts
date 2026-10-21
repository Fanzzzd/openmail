import { resolve } from "node:path";
import { expect, it } from "vitest";
import { profileDirectory } from "./profile-directory";

// A launch with only OPENMAIL_HOME set kept the database there but wrote Electron's profile into
// ~/Library/Application Support/OpenMail.
it("the profile follows --user-data-dir, then OPENMAIL_HOME, else Electron's default", () => {
  expect(profileDirectory("/tmp/profile", { OPENMAIL_HOME: "/tmp/home" })).toBe("/tmp/profile");
  expect(profileDirectory("relative/profile", {})).toBe(resolve("relative/profile"));
  expect(profileDirectory("", { OPENMAIL_HOME: "/tmp/home" })).toBe("/tmp/home");
  expect(profileDirectory("", { OPENMAIL_HOME: "relative/home" })).toBe(resolve("relative/home"));
  expect(profileDirectory("", { OPENMAIL_HOME: "" })).toBeUndefined();
  expect(profileDirectory("", {})).toBeUndefined();
});
