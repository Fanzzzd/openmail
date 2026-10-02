import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

/** Verifies the installed app, not build-time environment or an ad-hoc seal. */
export async function isSignedMacApp(bundle: string): Promise<boolean> {
  try {
    await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    const result = await execute("/usr/bin/codesign", ["--display", "--verbose=4", bundle]);
    return (
      /Authority=Developer ID Application:/.test(result.stderr) &&
      /TeamIdentifier=[A-Z0-9]+/.test(result.stderr)
    );
  } catch {
    return false;
  }
}
