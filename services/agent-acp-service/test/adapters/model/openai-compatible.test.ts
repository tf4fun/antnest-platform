import { describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleModel,
  OpenAICompatibleModelError,
} from "../../../src/adapters/model/openai-compatible.js";
import type { ModelRequest } from "../../../src/ports/model.js";

describe("OpenAICompatibleModel", () => {
  it("maps the complete Tool transcript and parses Tool calls", async () => {
    const fetchFn = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
    fetchFn.mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-2",
                  type: "function",
                  function: { name: "write", arguments: '{"path":"notes.txt","text":"ok"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    );
    const model = new OpenAICompatibleModel({ fetchFn });

    await expect(model.complete(request())).resolves.toEqual({
      kind: "tool_calls",
      content: [],
      calls: [
        {
          id: "call-2",
          name: "write",
          arguments: { path: "notes.txt", text: "ok" },
        },
      ],
      usage: { inputTokens: 11, outputTokens: 3 },
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/v1/chat/completions");
    expect(init?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer provider-secret" }),
    );
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("request body is not JSON text");
    }
    expect(JSON.parse(init.body) as unknown).toMatchObject({
      model: "example-model",
      max_tokens: 4096,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file contents" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object" },
          },
        },
      ],
    });
  });

  it("preserves mixed assistant text and reasoning alongside complete Tool calls", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "I will inspect the file.",
                  reasoning_content: "The request requires local evidence.",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"README.md"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    });

    await expect(model.complete(request())).resolves.toMatchObject({
      kind: "tool_calls",
      content: [{ type: "text", text: "I will inspect the file." }],
      thought: [{ type: "text", text: "The request requires local evidence." }],
    });
  });

  it("never executes Tool calls from a length-truncated model response", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "length",
                message: {
                  role: "assistant",
                  content: "Partial response",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "write", arguments: '{"path":"unfinished' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    });

    await expect(model.complete(request())).resolves.toEqual({
      kind: "message",
      content: [{ type: "text", text: "Partial response" }],
      stopReason: "max_tokens",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("records content filtering as refusal instead of successful completion", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "content_filter",
                message: { role: "assistant", content: null, refusal: "Request blocked" },
              },
            ],
          }),
        ),
      ),
    });

    await expect(model.complete(request())).resolves.toMatchObject({
      kind: "message",
      stopReason: "refusal",
      content: [{ type: "text", text: "Request blocked" }],
    });
  });

  it("rejects unknown Provider finish reasons", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "provider_magic",
                message: { role: "assistant", content: "done" },
              },
            ],
          }),
        ),
      ),
    });

    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
    });
  });

  it("maps a terminal text response", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
            usage: { prompt_tokens: 7, completion_tokens: 1 },
          }),
        ),
      ),
    });

    await expect(model.complete(request())).resolves.toEqual({
      kind: "message",
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 1 },
    });
  });

  it("preserves baseline ACP resource links as model-readable text", async () => {
    const fetchFn = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        }),
      ),
    );
    const model = new OpenAICompatibleModel({ fetchFn });
    const input = request();
    input.messages = [
      {
        role: "user",
        content: [
          {
            type: "resource_link",
            name: "Design",
            uri: "https://docs.example.test/design",
            description: "Architecture notes",
          },
        ],
      },
    ];

    await model.complete(input);

    const body = fetchFn.mock.calls[0]?.[1].body;
    if (typeof body !== "string") {
      throw new Error("request body is not JSON text");
    }
    expect(JSON.parse(body) as unknown).toMatchObject({
      messages: [
        {
          role: "user",
          content:
            "Resource: Design\nURI: https://docs.example.test/design\nDescription: Architecture notes",
        },
      ],
    });
  });

  it("preserves resource context when an image makes the prompt multimodal", async () => {
    const fetchFn = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        }),
      ),
    );
    const model = new OpenAICompatibleModel({ fetchFn });
    const input = request();
    input.snapshot.executionSpec.model.supportsImages = true;
    input.messages = [
      {
        role: "user",
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          {
            type: "resource_link",
            name: "Design",
            uri: "https://docs.example.test/design",
          },
          {
            type: "resource",
            resource: {
              uri: "file:///workspace/notes.txt",
              mimeType: "text/plain",
              text: "embedded notes",
            },
          },
        ],
      },
    ];

    await model.complete(input);

    const body = fetchFn.mock.calls[0]?.[1].body;
    if (typeof body !== "string") {
      throw new Error("request body is not JSON text");
    }
    expect(JSON.parse(body) as unknown).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
            {
              type: "text",
              text: "Resource: Design\nURI: https://docs.example.test/design",
            },
            {
              type: "text",
              text: "Embedded resource: file:///workspace/notes.txt\nembedded notes",
            },
          ],
        },
      ],
    });
  });

  it("rejects a Tool finish reason without a Tool call", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "tool_calls",
                message: { role: "assistant", content: null, tool_calls: [] },
              },
            ],
          }),
        ),
      ),
    });

    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
    });
  });

  it("rejects malformed Tool arguments instead of guessing", async () => {
    const model = new OpenAICompatibleModel({
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-2",
                      type: "function",
                      function: { name: "write", arguments: "not-json" },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    });

    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
      retryable: false,
    });
  });

  it("reports one failed request without retrying it", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(Response.json({ error: { message: "rate limited" } }, { status: 429 })),
    );
    const model = new OpenAICompatibleModel({ fetchFn });

    const error = await model.complete(request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAICompatibleModelError);
    expect(error).toMatchObject({ code: "model_http_error", retryable: true, status: 429 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

function request(): ModelRequest {
  return {
    snapshot: {
      admissionId: "admission-1",
      admissionDeadline: new Date("2026-08-30T00:10:00Z"),
      agentConfigRevision: "config-1",
      executionRevision: "execution-1",
      runtimeMcpSourceDigest: "a".repeat(64),
      agentExecutionSpecDigest: "b".repeat(64),
      credentialVersion: "credential-version-1",
      runtime: {
        generation: 1,
        instanceId: "runtime-1",
        executionId: "runtime-execution-1",
        mcpEndpoint: "http://runtime-1:8080/mcp",
      },
      executionSpec: {
        systemPrompt: "system",
        skillInstructions: [],
        model: {
          baseUrl: "https://api.example.test/v1",
          model: "example-model",
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          supportsImages: false,
        },
        maxModelRequests: 4,
        credentialRef: "credential-1",
      },
      clientMcpRevisionId: "client-mcp-1",
    },
    credential: "provider-secret",
    messages: [
      { role: "system", content: [{ type: "text", text: "system" }] },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [],
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "README.md" } }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: [{ type: "text", text: "file contents" }],
      },
    ],
    tools: [
      {
        source: "runtime",
        sourceId: "runtime",
        name: "read",
        modelName: "read",
        description: "Read a file",
        inputSchema: { type: "object" },
      },
    ],
    signal: new AbortController().signal,
  };
}
