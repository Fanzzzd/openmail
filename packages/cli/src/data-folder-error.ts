/** A data folder OpenMail can't create, explained in one sentence instead of a PlatformError. */

const REASONS: Partial<Record<string, string>> = {
  AlreadyExists: "a file with that name is in the way",
  BadResource: "part of the path is a file, not a folder",
  NotFound: "part of the path does not exist",
  PermissionDenied: "you don't have permission to create it",
};

/** The sentence for a failed makeDirectory, or undefined for any other defect. */
export function dataFolderError(defect: unknown, home: string | undefined): string | undefined {
  if (defect === null || typeof defect !== "object" || !("reason" in defect)) return undefined;
  const reason: unknown = defect.reason;
  if (reason === null || typeof reason !== "object") return undefined;
  if (!("method" in reason) || reason.method !== "makeDirectory") return undefined;
  const path =
    "pathOrDescriptor" in reason && typeof reason.pathOrDescriptor === "string"
      ? reason.pathOrDescriptor
      : home;
  if (!path) return undefined;
  const tag = "_tag" in reason && typeof reason._tag === "string" ? reason._tag : "";
  const why = REASONS[tag] ?? "OpenMail couldn't create it";
  return home
    ? `Can't use ${path} for OpenMail's data: ${why}. Set OPENMAIL_HOME to a folder you can write to.`
    : `Can't use ${path} for OpenMail's data: ${why}. Fix the folder or set OPENMAIL_HOME to one you can write to.`;
}
