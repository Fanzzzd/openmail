import { expect, it } from "vitest";
import { EXECUTABLE, safeFilename } from "./attachment-filenames";

it("blocks macOS launchers and configuration files alongside executables", () => {
  for (const ext of [
    "webloc",
    "inetloc",
    "fileloc",
    "url",
    "mobileconfig",
    "action",
    "definition",
    "prefPane",
    "saver",
    "osax",
    "shortcut",
    "appex",
    "workflow",
    "scpt",
    "scptd",
    "applescript",
    "terminal",
    "command",
    "tool",
    "jar",
    "exe",
    "sh",
    ..."html htm xhtml svg shtml mht mhtml iso img cdr sparseimage sparsebundle vhd docm xlsm pptm dotm xlam jnlp desktop appimage deb rpm run bundle plugin kext xpc ics vcf".split(
      " ",
    ),
  ])
    expect(EXECUTABLE.test(`file.${ext}`)).toBe(true);
});
it("blocks other Finder location files, active documents, macro templates and Windows launchers", () => {
  for (const ext of "afploc ftploc mailloc newsloc atloc term webarchive xht svgz xltm potm ppsm sldm ppam xla pif cpl msc scf vbe chm msp application gadget wsh psm1 sct inf settingcontent-ms library-ms appref-ms xll vhdx msix appx".split(
    " ",
  ))
    expect(EXECUTABLE.test(`file.${ext}`), ext).toBe(true);
  for (const ext of ["pdf", "docx", "xlsx", "png", "txt", "zip", "eml"])
    expect(EXECUTABLE.test(`file.${ext}`), ext).toBe(false);
});
it("blocks remote-session launchers, plug-in bundles, certificates and the rest of Outlook's level 1 list", () => {
  for (const ext of "rdp ica vncloc RDP qlgenerator mdimporter component inputplugin systemextension dext wdgt service colorPicker cer crt der ade adp accde mdb mde hlp htc ins msh1 mst msu ps1xml psc1 psd1 pyc pyw pyz shb shs theme vb vbp website ws wsb wsc xbap xnk diagcab appcontent-ms searchConnector-ms iqy slk".split(
    " ",
  ))
    expect(EXECUTABLE.test(`file.${ext}`), ext).toBe(true);
  for (const ext of ["rtf", "csv", "key", "pages", "numbers", "heic", "mov", "ics.pdf"])
    expect(EXECUTABLE.test(`file.${ext}`), ext).toBe(false);
});
it("replaces filename format characters and bounds UTF-8 length without losing the extension", () => {
  expect(safeFilename("report\u202E\u200F\u2066\u061C\uFEFF.pdf")).toBe("report_____.pdf");
  const name = safeFilename(`邮件😀${"邮件😀".repeat(699)}.mobileconfig`);
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
  expect(name.endsWith(".mobileconfig")).toBe(true);
  expect(name).not.toContain("\uFFFD");
});
