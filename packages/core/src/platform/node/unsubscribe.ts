import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { Effect } from "effect";
import { publicImageAddress } from "../../compose-images.js";
import { ProviderError } from "../../domain/errors.js";

/** Resolve once and pin TLS to a public address. No cookies, authorization or redirect follow-up. */
export const postUnsubscribe = (input: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const url = new URL(input);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== "443")
      )
        throw new Error("Invalid unsubscribe URL");
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = await lookup(hostname, { all: true });
      const first = addresses[0];
      if (!first || addresses.some((item) => !publicImageAddress(item.address)))
        throw new Error("Unsubscribe requires a public HTTPS address");
      await new Promise<void>((resolve, reject) => {
        const body = "List-Unsubscribe=One-Click";
        const req = request(
          url,
          {
            method: "POST",
            hostname: first.address,
            servername: hostname,
            signal,
            headers: {
              Host: url.host,
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": String(body.length),
            },
          },
          (response) => {
            response.destroy();
            if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) resolve();
            else reject(new Error("Unsubscribe request failed"));
          },
        );
        const timer = setTimeout(() => req.destroy(new Error("Unsubscribe timed out")), 15000);
        req.on("close", () => clearTimeout(timer));
        req.on("error", reject);
        req.end(body);
      });
    },
    catch: () => new ProviderError({ message: "Unsubscribe request failed" }),
  });
