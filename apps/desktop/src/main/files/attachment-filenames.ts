import { attachmentFilename } from "@openmail/core/schema";
import path from "node:path";
/**
 * Files that run code, install something or connect to a remote host when opened. They can be
 * saved, but not opened from the app. Beyond scripts and apps this covers remote-session
 * launchers that connect on double-click (rdp, ica, vncloc), macOS plug-in bundles that load into
 * other processes (qlgenerator, mdimporter, component, inputplugin, systemextension, dext, wdgt,
 * service, colorpicker), certificates Keychain Access imports on open (cer, crt, der), and the
 * Outlook level 1 blocked types that were missing (Access databases and projects, Windows Help,
 * PowerShell and Python variants, MSI transforms, Windows Sandbox, search connectors, web query
 * files).
 */
export const EXECUTABLE =
  /\.(rdp|ica|vncloc|qlgenerator|mdimporter|component|inputplugin|systemextension|dext|wdgt|service|colorpicker|cer|crt|der|ade|adp|accda|accde|accdr|accdt|mad|maf|mag|mam|maq|mar|mas|mat|mau|mav|maw|mda|mdb|mde|mdt|mdw|mdz|hlp|hpj|cnt|grp|htc|ins|isp|its|mcf|msh|msh1|msh2|mshxml|msh1xml|msh2xml|mst|msu|ops|osd|pcd|plg|prf|prg|printerexport|ps1xml|ps2|ps2xml|psc1|psc2|psd1|psdm1|pyc|pyo|pyw|pyz|pyzw|shb|shs|theme|vb|vbp|vsmacros|vsw|webpnp|website|ws|wsb|wsc|xbap|xnk|diagcab|appcontent-ms|searchconnector-ms|iqy|slk|webloc|inetloc|fileloc|url|mobileconfig|action|definition|prefPane|saver|osax|shortcut|appex|app|command|tool|sh|bash|zsh|csh|ksh|pkg|mpkg|dmg|scpt|scptd|applescript|workflow|terminal|jar|exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|hta|lnk|reg|dll|so|dylib|py|pl|rb|php|html|htm|xhtml|svg|shtml|mht|mhtml|iso|img|cdr|sparseimage|sparsebundle|vhd|docm|xlsm|pptm|dotm|xlam|jnlp|desktop|appimage|deb|rpm|run|bundle|plugin|kext|xpc|ics|vcf|afploc|ftploc|mailloc|newsloc|atloc|term|webarchive|xht|svgz|xltm|potm|ppsm|sldm|ppam|xla|pif|cpl|msc|scf|vbe|chm|msp|application|gadget|wsh|psm1|sct|inf|settingcontent-ms|library-ms|appref-ms|xll|vhdx|msix|appx)$/i;

export const launcherBlockedMessage = (filename: string) =>
  `${filename} can run code. Save it and open it yourself if you trust it.`;

/** A filename that stays inside the folder it is written to. */
export function safeFilename(name: string): string {
  const base = path
    .basename(name.replaceAll("\\", "/"))
    .replace(/[/:]/g, "_")
    .replaceAll(/./gsu, (c) => (c.charCodeAt(0) < 32 ? "_" : c))
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return attachmentFilename(base || "attachment").trim();
}
