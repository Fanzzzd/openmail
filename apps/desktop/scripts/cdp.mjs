// A small Chrome DevTools Protocol client for the smoke scripts (scripts/smoke.mjs here and
// the root scripts/smoke-dist.mjs). Every fetch and every call has a deadline, and closing
// the socket rejects the calls still waiting for a reply.

/** A number of milliseconds, or a function that returns one each time it is read. */
const ms = (value) => Math.max(1, typeof value === "function" ? value() : value);

/**
 * The targets the DevTools endpoint on `port` lists, or [] when it does not answer within
 * `timeoutMs` or answers with something else.
 */
export async function listTargets(port, { timeoutMs = 1000 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(ms(timeoutMs)),
    });
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  } catch {
    return [];
  }
}

/**
 * Opens the target's debugger socket.
 * `connectTimeoutMs` bounds the open; `callTimeoutMs` bounds each call; `closeReason` is the
 * message pending calls fail with when the socket closes.
 */
export async function connectCdp(
  url,
  { connectTimeoutMs = 10_000, callTimeoutMs = 10_000, closeReason = () => "CDP closed" } = {},
) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const settle = (error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      if (error) {
        socket.close();
        reject(error);
      } else resolve();
    };
    const opened = () => settle();
    const failed = () => settle(new Error("CDP connection failed"));
    const timer = setTimeout(
      () => settle(new Error("CDP connection timeout")),
      ms(connectTimeoutMs),
    );
    // setTimeout resolves to the Node or the DOM type depending on which tsconfig oxlint picks for
    // this file, so the optional call is needed for one and redundant for the other.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    timer.unref?.();
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
  });

  const pending = new Map();
  const listeners = new Set();
  let sequence = 0;
  let closed = false;
  socket.addEventListener("message", ({ data }) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        request?.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else request?.resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => {
    closed = true;
    const reason = closeReason();
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
  });

  function send(method, params = {}, { timeoutMs = callTimeoutMs } = {}) {
    if (closed || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error(closeReason()));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, ms(timeoutMs));
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    socket,
    send,
    /** Runs `expression` in the page and returns its value; a thrown exception rejects. */
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error("Smoke UI evaluation failed");
      return result.result?.value;
    },
    /** The page as PNG bytes. */
    async screenshot() {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    },
    /** Calls `listener` with every event frame (frames without an `id`). Returns an unsubscribe. */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      socket.close();
    },
  };
}
