const log = (value) => process.stdout.write(`${value}\n`);
// Local fake IMAP only. Three IDLE connections, then 100 connect/close cycles.
import { createServer } from "node:net";
import { ImapFlow } from "imapflow";
import { keepInboxIdle } from "../dist/platform/node/imap-idle.js";

const ignore = () => {
  /* Connection errors are expected when the fake peer closes. */
};
const sockets = new Set();
const server = createServer((socket) => {
  socket.on("error", ignore);
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.write("* OK [CAPABILITY IMAP4rev1 IDLE] test\r\n");
  let buffer = "";
  let idleTag;
  socket.on("data", (bytes) => {
    buffer += bytes.toString();
    let end;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const [tag, command] = line.split(" ");
      if (line === "DONE") socket.write(`${idleTag} OK done\r\n`);
      else if (command === "CAPABILITY")
        socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK\r\n`);
      else if (command === "EXAMINE" || command === "SELECT")
        socket.write(
          `* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT 2] next\r\n${tag} OK selected\r\n`,
        );
      else if (command === "IDLE") {
        idleTag = tag;
        socket.write("+ idling\r\n");
      } else socket.write(`${tag} OK\r\n`);
    }
  });
});
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing local test port");
const open = async () => {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: address.port,
    secure: false,
    doSTARTTLS: false,
    auth: { user: "test", pass: "test" },
    logger: false,
    disableAutoIdle: true,
  });
  client.on("error", ignore);
  const controller = new AbortController();
  await client.connect();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const watching = keepInboxIdle(client, controller.signal, ignore, started);
  await ready;
  return async () => {
    controller.abort();
    await watching.catch(ignore);
    for (const event of ["exists", "flags", "expunge"])
      if (client.listenerCount(event)) throw new Error(`Leaked ${event} listener`);
  };
};
try {
  global.gc();
  const baseline = process.memoryUsage();
  const connections = [];
  for (let i = 0; i < 3; i++) connections.push(await open());
  global.gc();
  const active = process.memoryUsage();
  for (const close of connections) await close();
  connections.length = 0;
  const retained = [];
  for (let batch = 0; batch < 3; batch++) {
    for (let i = 0; i < 100; i++) await (await open())();
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    global.gc();
    retained.push((process.memoryUsage().heapUsed - baseline.heapUsed) / 1024);
  }
  log(
    JSON.stringify({
      activeConnections: 3,
      activeHeapKiB: (active.heapUsed - baseline.heapUsed) / 1024,
      cycles: 300,
      remainingSockets: sockets.size,
      retainedHeapKiB: retained,
    }),
  );
  if (sockets.size) throw new Error("Leaked IDLE socket");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => {
    server.close(resolve);
  });
}
