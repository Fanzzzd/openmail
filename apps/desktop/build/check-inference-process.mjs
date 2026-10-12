/** Tiny crash/IPC isolation check: no models, mail, network or real app profile. */
import { app } from "electron";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { desktopInferenceProcess } from "../src/main/app/inference.ts";
const profile = mkdtempSync(join(tmpdir(), "openmail-inference-isolation-"));
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setAppLogsPath(profile);
const entry = join(profile, "child.mjs");
writeFileSync(
  entry,
  "process.parentPort.on('message',event=>{if(event.data==='exit')process.exit(7);else process.parentPort.postMessage({pid:process.pid},[]);});",
);
app.once("ready", async () => {
  let code = 0;
  try {
    const child = desktopInferenceProcess(entry, profile);
    const message = new Promise((resolve) => {
      child.onMessage(resolve);
    });
    child.send({ kind: "query", text: "synthetic" });
    const reply = await message;
    assert.ok(reply.pid !== process.pid);
    const exited = new Promise((resolve) => {
      child.onFailure(resolve);
    });
    // Simulate a native process failure using the owned child's PID only.
    process.kill(reply.pid, "SIGKILL");
    await exited;
    await child.kill();
    process.stdout.write(
      "Electron utilityProcess: independent PID and child crash isolation passed\n",
    );
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    code = 1;
  } finally {
    rmSync(profile, { recursive: true, force: true });
    app.exit(code);
  }
});
