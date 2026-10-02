export const assistantShortcut = (platform: string): string =>
  /Mac|darwin/i.test(platform) ? "⌘J" : "Ctrl+J";
