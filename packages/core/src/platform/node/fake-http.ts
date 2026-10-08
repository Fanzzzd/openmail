import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/http";

export interface FakeHttpCall {
  /** "METHOD /path", the key the call was routed by. */
  route: string;
  method: string;
  url: URL;
  body: unknown;
  contentType: string;
  prefer: string | undefined;
}
export type FakeHttpReply = {
  headers?: Record<string, string>;
  status?: number;
  json?: unknown;
  text?: string;
  /**
   * A broken network: a DNS failure or a reset connection before any response; a server
   * that never sends headers; or a body that stalls or resets after its first half.
   */
  fault?: "ENOTFOUND" | "ECONNRESET" | "stall-headers" | "stall-body" | "reset-body";
  /** Milliseconds before the reply or fault, such as a slow upload of the request body. */
  delay?: number;
};

/** fetch reports socket errors as a TypeError whose cause carries the Node error code. */
const socketError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(code), { code }),
  });

function faultyBody(text: string, fault: "stall-body" | "reset-body") {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, Math.floor(bytes.length / 2)));
      if (fault === "reset-body") controller.error(socketError("ECONNRESET").cause);
    },
  });
}

/** Routes are keyed by METHOD and the API-relative path; missing routes return 404. */
export function fakeHttp(
  routes: Record<string, FakeHttpReply | ((url: URL, call: FakeHttpCall) => FakeHttpReply)>,
) {
  const calls: FakeHttpCall[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const text =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const contentType = request.body._tag === "Uint8Array" ? request.body.contentType : "";
      const body: unknown = contentType.startsWith("application/json")
        ? JSON.parse(text)
        : text || undefined;
      const path = url.pathname.replace(/^\/(?:v1\.0|gmail\/v1\/users\/me)/, "");
      const call = {
        route: `${request.method} ${path}`,
        method: request.method,
        url,
        body,
        contentType,
        prefer: request.headers["prefer"],
      };
      calls.push(call);
      const route = routes[call.route];
      const reply = typeof route === "function" ? route(url, call) : (route ?? { status: 404 });
      return Effect.sleep(reply.delay ?? 0).pipe(Effect.andThen(respond(request, reply)));
    }),
  );
  return { client, layer: Layer.succeed(HttpClient.HttpClient)(client), calls };
}

function respond(request: HttpClientRequest.HttpClientRequest, reply: FakeHttpReply) {
  const { fault } = reply;
  if (fault === "stall-headers") return Effect.never;
  if (fault === "ENOTFOUND" || fault === "ECONNRESET")
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause: socketError(fault) }),
      }),
    );
  const payload = reply.text ?? (reply.json === undefined ? null : JSON.stringify(reply.json));
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(fault ? faultyBody(payload ?? "", fault) : payload, {
        status: reply.status ?? 200,
        headers: reply.headers,
      }),
    ),
  );
}

type FakeRoute = FakeHttpReply | ((url: URL, call: FakeHttpCall) => FakeHttpReply);
const GRAPH_FOLDERS = ["inbox", "sentitems", "drafts", "junkemail", "deleteditems"];

/**
 * Graph routes for the well-known folders (no Archive) and `custom` folder ids: each
 * folder lookup returns `id-<name>`, and each delta is empty unless `deltas` replaces it.
 */
export function graphFolderRoutes(
  deltas: Record<string, FakeRoute>,
  custom: readonly string[] = [],
): Record<string, FakeRoute> {
  const routes: Record<string, FakeRoute> = {};
  for (const name of GRAPH_FOLDERS)
    routes[`GET /me/mailFolders/${name}`] = { json: { id: `id-${name}` } };
  for (const key of [...GRAPH_FOLDERS, ...custom])
    routes[`GET /me/mailFolders/${key}/messages/delta`] = deltas[key] ?? {
      json: {
        value: [],
        "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/mailFolders/${key}/messages/delta?$deltatoken=${key}`,
      },
    };
  return routes;
}
