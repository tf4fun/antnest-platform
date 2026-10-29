import { syntheticProviderDestination } from "../../support/model-network.js";
import { describe, expect, it } from "vitest";

import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import {
  ModelTransportCleanupError,
  type AuthenticatedModelRequest,
} from "../../../src/ports/model.js";

function request(): AuthenticatedModelRequest {
  return {
    credential: "credential-1",
    snapshot: {
      organizationId: "organization-1",
      providerConnectionId: "connection-1",
      modelProfileId: "profile-1",
      configurationRevision: 1,
      accessRevision: "access-1",
      deadlineAt: new Date("2026-08-30T00:10:00Z"),
      agentSpecRevision: "config-1",
      executionRevision: "execution-1",
      runtimeMcpSourceDigest: "a".repeat(64),
      agentExecutionSpecDigest: "b".repeat(64),
      runtime: {
        revision: "runtime-1",
        executionId: "runtime-execution-1",
        mcpEndpoint: "http://runtime-1:8080/mcp",
        connectionId: "rci_11111111111111111111111111111111",
      },
      executionSpec: {
        systemPrompt: "system",
        contextPolicyVersion: "context-v1",
        skillInstructions: [],
        model: {
          baseUrl: "https://api.example.test/v1",
          model: "example-model",
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          supportsImages: false,
        },
        maxModelRequests: 4,
      },
      clientMcpRevisionId: "client-mcp-1",
    },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("OpenAICompatibleModel context overflow mapping", () => {
  it("maps a context_length_exceeded HTTP 400 to a non-retryable context_overflow error", async () => {
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () =>
        Promise.resolve(
          Response.json(
            { error: { code: "context_length_exceeded", message: "context too large" } },
            { status: 400 },
          ),
        ),
    });
    await expect(model.complete(request())).rejects.toMatchObject({
      code: "context_overflow",
      retryable: false,
      status: 400,
    });
  });

  it("keeps an unrelated HTTP 400 as a generic model_http_error", async () => {
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () =>
        Promise.resolve(
          Response.json(
            { error: { code: "invalid_request", message: "bad request" } },
            { status: 400 },
          ),
        ),
    });
    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_http_error",
      status: 400,
    });
  });

  it("marks context_length_exceeded stream errors after emitted output as outputStarted", async () => {
    const deltas = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { code: "context_length_exceeded", message: "context too large" } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () =>
        Promise.resolve(new Response(deltas, { headers: { "content-type": "text/event-stream" } })),
    });
    const failure = await model.complete({ ...request(), onDelta: () => Promise.resolve() }).then(
      () => {
        throw new Error("Expected completion to fail");
      },
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "context_overflow",
      retryable: false,
      outputStarted: true,
    });
  });

  it.each([400, 413, 422])(
    "keeps empty and null HTTP %i bodies as model_http_error",
    async (status) => {
      for (const body of ["", null]) {
        const model = new OpenAICompatibleModel({
          destination: syntheticProviderDestination,
          fetchFn: () => Promise.resolve(new Response(body, { status })),
        });
        await expect(model.complete(request())).rejects.toMatchObject({
          code: "model_http_error",
          status,
          retryable: false,
        });
      }
    },
  );

  it.each([400, 413, 422])("keeps non-JSON HTTP %i bodies as model_http_error", (status) => {
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () =>
        Promise.resolve(
          new Response("<html>not json</html>", {
            status,
            headers: { "content-type": "text/html" },
          }),
        ),
    });
    return expect(model.complete(request())).rejects.toMatchObject({
      code: "model_http_error",
      status,
      retryable: false,
    });
  });

  it.each([400, 413, 422])("keeps unrelated HTTP %i errors as model_http_error", (status) => {
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () =>
        Promise.resolve(
          Response.json({ error: { code: "invalid_request", message: "bad request" } }, { status }),
        ),
    });
    return expect(model.complete(request())).rejects.toMatchObject({
      code: "model_http_error",
      status,
      retryable: false,
    });
  });

  it.each([400, 413, 422])(
    "keeps an oversized declared HTTP %i body as model_http_error",
    (status) => {
      const model = new OpenAICompatibleModel({
        destination: syntheticProviderDestination,
        fetchFn: () =>
          Promise.resolve(
            new Response("x", {
              status,
              headers: { "content-length": String(8 * 1024 * 1024) },
            }),
          ),
      });
      return expect(model.complete(request())).rejects.toMatchObject({
        code: "model_http_error",
        status,
        retryable: false,
      });
    },
  );

  it("propagates a body cancellation failure on declared oversize carrying both causes", async () => {
    const cleanupError = new Error("cancel rejected");
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel: () => Promise.reject(cleanupError) }),
      { status: 413, headers: { "content-length": String(8 * 1024 * 1024) } },
    );
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () => Promise.resolve(response),
    });
    const failure = await model.complete(request()).then(
      () => {
        throw new Error("Expected completion to fail");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModelTransportCleanupError);
    const cause = (failure as ModelTransportCleanupError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    const causes = (cause as AggregateError).errors;
    expect(causes).toHaveLength(2);
    expect(causes[0]).toMatchObject({ code: "model_http_error", status: 413 });
    expect(causes[1]).toBe(cleanupError);
  });

  it("propagates a body cancellation failure on streamed oversize carrying both causes", async () => {
    const cleanupError = new Error("cancel rejected");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)),
        cancel: () => Promise.reject(cleanupError),
      }),
      { status: 400 },
    );
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () => Promise.resolve(response),
    });
    const failure = await model.complete(request()).then(
      () => {
        throw new Error("Expected completion to fail");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModelTransportCleanupError);
    const cause = (failure as ModelTransportCleanupError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    const causes = (cause as AggregateError).errors;
    expect(causes).toHaveLength(2);
    expect(causes[0]).toMatchObject({ code: "model_http_error", status: 400 });
    expect(causes[1]).toBe(cleanupError);
  });

  it("keeps a streamed oversize body as model_http_error when cancellation succeeds", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)),
      }),
      { status: 413 },
    );
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () => Promise.resolve(response),
    });
    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_http_error",
      status: 413,
      retryable: false,
    });
  });
});
