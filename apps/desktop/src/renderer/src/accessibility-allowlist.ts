/**
 * Snapshot of reviewed moderate axe findings. Match fixture, rule and targets,
 * and explain each exception here. Serious/critical findings are never allowed.
 * Empty because the audited fixtures currently have no moderate violations.
 */
export const moderateAllowlist: readonly {
  fixture: string;
  rule: string;
  targets: readonly (readonly string[])[];
  reason: string;
}[] = [];
