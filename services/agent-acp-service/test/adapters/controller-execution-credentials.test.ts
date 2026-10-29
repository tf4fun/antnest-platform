import { describe, expect, it, vi } from "vitest";
import { ControllerExecutionCredentialsClient } from "../../src/adapters/controller-execution-credentials.js";
import type { ExecutionCredentialScope } from "../../src/ports/execution-credentials.js";

const origin = "https://controller.example.test";
const scope: ExecutionCredentialScope = {
  organization_id: "organization-1",
  connection_id: "provider-1",
  credential_version: "credential-1",
};
const resolved = {
  organization_id: scope.organization_id,
  connection_id: scope.connection_id,
  credential_version: scope.credential_version,
  method: "api_key",
  secret: "synthetic-canary-secret",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function fetcherReturning(response: () => Response | Promise<Response>) {
  return vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>(
    async () => await response(),
  );
}

describe("ControllerExecutionCredentialsClient", () => {
  it("posts the exact scope to the Controller resolve route with bounded safe options", async () => {
    const fetcher = fetcherReturning(() => jsonResponse(resolved));
    const client = new ControllerExecutionCredentialsClient(origin, fetcher);
    const signal = new AbortController().signal;
    const result = await client.resolve(scope, signal);
    expect(result).toEqual(resolved);
    const [input, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(input.toString()).toBe(
      "https://controller.example.test/internal/execution-credentials/resolve",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(scope));
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toContain("application/json");
    expect(headers.get("accept")).toContain("application/json");
    expect(init.signal?.aborted).toBe(false);
  });

  it("rejects invalid adapter origins and scopes without calling the fetcher", async () => {
    const fetcher = fetcherReturning(() => jsonResponse(resolved));
    for (const candidate of [
      "ftp://controller.example.test",
      "https://user@controller.example.test",
      "https://controller.example.test/path",
      "https://controller.example.test/?x=1",
      "https://controller.example.test/#hash",
    ]) {
      expect(() => new ControllerExecutionCredentialsClient(candidate, fetcher)).toThrow();
    }
    const client = new ControllerExecutionCredentialsClient(origin, fetcher);
    for (const field of ["organization_id", "connection_id", "credential_version"] as const) {
      await expect(
        client.resolve({ ...scope, [field]: "" }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
      await expect(
        client.resolve({ ...scope, [field]: "x".repeat(201) }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "provider_unavailable" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes every failure into provider_unavailable without leaking the canary", async () => {
    const cases: (() => Promise<Response> | Response)[] = [
      () => jsonResponse(resolved, { status: 404 }),
      () => jsonResponse(resolved, { status: 503 }),
      () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      () => jsonResponse(resolved, { status: 200, headers: { "content-type": "text/plain" } }),
      () =>
        new Response(new Uint8Array([0xff, 0xfe]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(JSON.stringify({ other: 1 }), {
          status: 302,
          headers: { "content-type": "application/json" },
        }),
      () => jsonResponse({ ...resolved, organization_id: "other-org" }),
      () => jsonResponse({ ...resolved, connection_id: "other-conn" }),
      () => jsonResponse({ ...resolved, credential_version: "other-version" }),
      () => jsonResponse({ ...resolved, method: "bearer" }),
      () => jsonResponse({ ...resolved, secret: "" }),
      () => jsonResponse({ ...resolved, extra: true }),
      () =>
        new Response('{"a":1,"a":2}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(
          new ReadableStream({
            pull() {
              throw new Error("reader exploded " + resolved.secret);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      () => Promise.reject(new Error("network exploded " + resolved.secret)),
      () =>
        new Response("{}".repeat(70 * 1024), {
          status: 200,
          headers: {
            "content-length": String(70 * 1024),
            "content-type": "application/json",
          },
        }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(70 * 1024));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ];
    for (const respond of cases) {
      const fetcher = fetcherReturning(respond);
      const client = new ControllerExecutionCredentialsClient(origin, fetcher);
      const error = await client
        .resolve(scope, new AbortController().signal)
        .catch((candidate: unknown) => candidate);
      expect(error).toMatchObject({ code: "provider_unavailable" });
      expect(error).not.toBeInstanceOf(Response);
      expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(resolved.secret);
      expect(JSON.stringify((error as { cause?: unknown }).cause ?? null)).not.toContain(
        resolved.secret,
      );
    }
  });

  it("stays uniform when a canary reader fails while the caller aborts", async () => {
    const abort = new AbortController();
    const response = new Response(
      new ReadableStream({
        start() {
          abort.abort();
        },
        pull() {
          throw new Error("reader exploded " + resolved.secret);
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetcher = fetcherReturning(() => response);
    const client = new ControllerExecutionCredentialsClient(origin, fetcher);
    const error = await client.resolve(scope, abort.signal).catch((c: unknown) => c);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(resolved.secret);
    expect(JSON.stringify((error as { cause?: unknown }).cause ?? null)).not.toContain(
      resolved.secret,
    );
  });

  it("cancels the body on declared oversize, non-200 and streamed oversize", async () => {
    const source = {
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        for (let i = 0; i < 16; i++) controller.enqueue(new Uint8Array(8 * 1024));
      },
      cancel: vi.fn(),
    };
    for (const [respond, sourceCancel] of [
      [
        () =>
          new Response("{}".repeat(70 * 1024), {
            status: 200,
            headers: {
              "content-length": String(70 * 1024),
              "content-type": "application/json",
            },
          }),
        undefined,
      ],
      [() => jsonResponse(resolved, { status: 503 }), undefined],
      [
        () =>
          new Response(new ReadableStream(source), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        source.cancel,
      ],
    ] as const) {
      const response = respond();
      const cancel = sourceCancel ?? vi.spyOn(response.body!, "cancel");
      const fetcher = fetcherReturning(() => response);
      const client = new ControllerExecutionCredentialsClient(origin, fetcher);
      await expect(client.resolve(scope, new AbortController().signal)).rejects.toMatchObject({
        code: "provider_unavailable",
      });
      expect(cancel).toHaveBeenCalled();
    }
  });

  it("leaves no abort listeners on the combined signal after resolution", async () => {
    const { getEventListeners } = await import("node:events");
    const fetcher = fetcherReturning(() => jsonResponse(resolved));
    const client = new ControllerExecutionCredentialsClient(origin, fetcher);
    await client.resolve(scope, new AbortController().signal);
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(getEventListeners(init.signal!, "abort")).toHaveLength(0);
  });

  it("aborts a pending resolve on the caller signal and bounds hung streams", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async () => {
      await new Promise(() => {});
      return jsonResponse(resolved);
    });
    const client = new ControllerExecutionCredentialsClient(origin, fetcher);
    const pending = client.resolve(scope, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    const stalled = vi.fn(() =>
      Promise.resolve(
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const bounded = new ControllerExecutionCredentialsClient(origin, stalled);
    await expect(bounded.resolve(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
});
