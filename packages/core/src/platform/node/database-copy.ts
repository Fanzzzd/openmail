import { copyFileSync, chmodSync, existsSync, lstatSync, rmSync, statSync } from "node:fs";

type CopyPolicy =
  | { readonly kind: "corpus" }
  | {
      readonly kind: "smoke";
      readonly sourceConfig: string | undefined;
      readonly targetConfig: string;
    };

/** Copy DB/WAL without opening the source; each caller retains its existing stability policy. */
export function copyQuiescentDatabase(
  source: string,
  target: string,
  policy: CopyPolicy = { kind: "corpus" },
): "copied" | "changed" | "invalid" {
  const files = [
    { source, target },
    { source: `${source}-wal`, target: `${target}-wal` },
    ...(policy.kind === "smoke" && policy.sourceConfig
      ? [{ source: policy.sourceConfig, target: policy.targetConfig }]
      : []),
  ].filter((file) => existsSync(file.source));
  if (
    policy.kind === "corpus" &&
    (files[0]?.source !== source || files.some((file) => !lstatSync(file.source).isFile()))
  )
    return "invalid";
  const before = files.map((file) => statSync(file.source));
  if (policy.kind === "corpus")
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  for (const file of files) {
    copyFileSync(file.source, file.target);
    chmodSync(file.target, 0o600);
  }
  const stable = files.every((file, index) => {
    if (policy.kind === "corpus" && !existsSync(file.source)) return false;
    const after = statSync(file.source),
      prior = before[index];
    return Boolean(
      prior &&
      after.size === prior.size &&
      after.mtimeMs === prior.mtimeMs &&
      (policy.kind === "smoke" || (after.ino === prior.ino && after.ctimeMs === prior.ctimeMs)),
    );
  });
  const unchanged =
    stable &&
    existsSync(`${source}-wal`) === files.some((file) => file.source === `${source}-wal`) &&
    (policy.kind !== "smoke" ||
      !policy.sourceConfig ||
      existsSync(policy.sourceConfig) ===
        files.some((file) => file.source === policy.sourceConfig));
  return unchanged ? "copied" : "changed";
}
