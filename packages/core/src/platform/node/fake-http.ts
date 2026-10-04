import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

export interface FakeHttpCall {
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
};

/** Routes are keyed by METHOD and the API-relative path; missing routes return 404. */
export function fakeHttp(
  routes: Record<string, FakeHttpReply | ((url: URL, call: FakeHttpCall) => FakeHttpReply)>,
) {
  const calls: FakeHttpCall[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const text =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const contentType = request.body._tag === "Uint8Array" ? request.body.contentType : "";
      const body: unknown = contentType.startsWith("application/json")
        ? JSON.parse(text)
        : text || undefined;
      const call = {
        method: request.method,
        url,
        body,
        contentType,
        prefer: request.headers["prefer"],
      };
      calls.push(call);
      const path = url.pathname.replace(/^\/(?:v1\.0|gmail\/v1\/users\/me)/, "");
      const route = routes[`${request.method} ${path}`];
      const reply = typeof route === "function" ? route(url, call) : (route ?? { status: 404 });
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.text ?? (reply.json === undefined ? null : JSON.stringify(reply.json)), {
          status: reply.status ?? 200,
          headers: reply.headers,
        }),
      );
    }),
  );
  return { client, layer: Layer.succeed(HttpClient.HttpClient)(client), calls };
}
