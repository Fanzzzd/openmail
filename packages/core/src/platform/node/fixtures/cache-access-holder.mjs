import { acquireDatabaseAccess } from "../../../../dist/platform/node/database-access.js";
const lease = acquireDatabaseAccess(process.argv[2], "shared");
process.send("ready");
process.on("message", () => {
  lease.release();
  process.disconnect();
});
