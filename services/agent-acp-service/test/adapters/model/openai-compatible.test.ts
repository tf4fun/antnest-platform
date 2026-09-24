import { describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleModel,
  OpenAICompatibleModelError,
} from "../../../src/adapters/model/openai-compatible.js";
import type { AuthenticatedModelRequest } from "../../../src/ports/model.js";

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Missing JSON request body");
  return init.body;
}

describe("OpenAICompatibleModel", () => {
  it("rejects an oversized non-streaming completion before parsing or publishing it", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(4 * 1024 * 1024, 0x20));
        controller.enqueue(Buffer.from("x"));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const model = new OpenAICompatibleModel({
      fetchFn: () =>
        Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } })),
    });
    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
      message: "Model response exceeded the size limit",
    });
    expect(cancelled).toBe(1);
  });

  it("rejects a declared oversized non-streaming body without reading it", async () => {
    let reads = 0;
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reads += 1;
      },
      cancel() {
        cancelled += 1;
      },
    });
    const model = new OpenAICompatibleModel({
      fetchFn: () =>
        Promise.resolve(
          new Response(body, {
            headers: {
              "content-type": "application/json",
              "content-length": String(4 * 1024 * 1024 + 1),
            },
          }),
        ),
    });
    await expect(model.complete(request())).rejects.toMatchObject({
      code: "model_invalid_response",
      message: "Model response exceeded the size limit",
    });
    expect(cancelled).toBe(1);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("uses OpenRouter's authenticated endpoint and preserves streamed tool calls and usage", async () => {
    const packets = [
      { choices: [{ index: 0, delta: { content: "Checking" }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      {
        choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: "tool_calls" },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      },
    ];
    const fetchFn = vi
      .fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    const input = request();
    input.snapshot.executionSpec.model.baseUrl = "https://openrouter.ai/api/v1";
    input.snapshot.executionSpec.model.model = "openai/gpt-4o-mini";
    const result = await new OpenAICompatibleModel({ fetchFn }).complete(input);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(fetchFn.mock.calls[0]?.[1].headers).get("authorization")).toBe(
      `Bearer ${input.credential}`,
    );
    expect(JSON.parse(bodyText(fetchFn.mock.calls[0]?.[1]))).not.toHaveProperty("thinking");
    expect(result).toMatchObject({
      kind: "tool_calls",
      calls: [{ id: "call-1", name: "read", arguments: {} }],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });
  it.each([undefined, "off", "low", "high", "max"] as const)(
    "sends the actual DeepSeek thinking selection %s",
    async (effort) => {
      const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
        Promise.resolve(
          Response.json({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
          }),
        ),
      );
      const input = request();
      input.snapshot.executionSpec.model.temperature = 0.7;
      if (effort !== undefined)
        input.snapshot.executionSpec.model.thinking = { protocol: "deepseek", effort };
      await new OpenAICompatibleModel({ fetchFn }).complete(input);
      const payload = JSON.parse(bodyText(fetchFn.mock.calls[0]?.[1])) as Record<string, unknown>;
      expect(payload.thinking).toEqual(
        effort === undefined ? undefined : { type: effort === "off" ? "disabled" : "enabled" },
      );
      expect(payload.reasoning_effort).toBe(
        effort === undefined || effort === "off" ? undefined : effort,
      );
      expect(payload.temperature).toBe(effort === undefined || effort === "off" ? 0.7 : undefined);
      expect(payload).not.toHaveProperty("thinking_effort");
    },
  );
  it.each(["", null, undefined])("preserves the presence of reasoning %s", async (reasoning) => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
                tool_calls: [
                  { id: "read", type: "function", function: { name: "read", arguments: "{}" } },
                ],
              },
            },
          ],
        }),
      ),
    );
    const model = new OpenAICompatibleModel({ fetchFn });
    const result = await model.complete(request());
    expect(result.thought).toEqual(
      reasoning === undefined ? undefined : [{ type: "text", text: "" }],
    );
    if (result.kind !== "tool_calls") throw new Error("Expected tools");
    const next = request();
    next.messages = [
      {
        role: "assistant",
        content: [],
        toolCalls: result.calls,
        ...(result.thought === undefined ? {} : { thought: result.thought }),
      },
    ];
    await model.complete(next);
    const body = JSON.parse(bodyText(fetchFn.mock.calls[1]?.[1])) as {
      messages: Record<string, unknown>[];
    };
    expect(body.messages[0]?.reasoning_content).toBe(reasoning === undefined ? undefined : "");
  });
  it("returns retained assistant reasoning with both tool and final-answer history", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        }),
      ),
    );
    const input = request();
    input.messages = [
      {
        role: "assistant",
        content: [],
        thought: [{ type: "text", text: "inspect first" }],
        toolCalls: [{ id: "a", name: "read", arguments: {} }],
      },
      { role: "tool", toolCallId: "a", content: [{ type: "text", text: "file" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        thought: [{ type: "text", text: "verified" }],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ];
    await new OpenAICompatibleModel({ fetchFn }).complete(input);
    const payload = JSON.parse(bodyText(fetchFn.mock.calls[0]?.[1])) as {
      messages: Record<string, unknown>[];
    };
    expect(payload.messages[0]).toMatchObject({
      reasoning_content: "inspect first",
      content: null,
    });
    expect(payload.messages[2]).toMatchObject({ reasoning_content: "verified", content: "done" });
    expect(payload.messages[3]).not.toHaveProperty("reasoning_content");
  });

  it("places Tool images after all replies in a multi-Tool batch", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        }),
      ),
    );
    const input = request();
    input.snapshot.executionSpec.model.supportsImages = true;
    input.messages = [
      {
        role: "assistant",
        content: [],
        toolCalls: [
          { id: "a", name: "screenshot", arguments: {} },
          { id: "b", name: "read", arguments: {} },
        ],
      },
      {
        role: "tool",
        toolCallId: "a",
        content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
      },
      { role: "tool", toolCallId: "b", content: [{ type: "text", text: "file" }] },
    ];
    await new OpenAICompatibleModel({ fetchFn }).complete(input);
    const body = JSON.parse(bodyText(fetchFn.mock.calls[0]?.[1])) as {
      messages: { role: string }[];
    };
    expect(body.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
  });

  it.each([true, false])(
    "handles Tool images with vision=%s without breaking the next model request",
    async (vision) => {
      const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
        Promise.resolve(
          Response.json({
            choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
          }),
        ),
      );
      const input = request();
      input.snapshot.executionSpec.model.supportsImages = vision;
      input.messages.push({
        role: "tool",
        toolCallId: "image-call",
        content: [
          { type: "text", text: "Screenshot" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
      });
      await expect(new OpenAICompatibleModel({ fetchFn }).complete(input)).resolves.toMatchObject({
        kind: "message",
      });
      const payload = JSON.parse(bodyText(fetchFn.mock.calls[0]?.[1])) as {
        messages: Record<string, unknown>[];
      };
      expect(payload.messages[4]).toMatchObject({ role: "tool", tool_call_id: "image-call" });
      expect(JSON.stringify(payload.messages)).toContain("Screenshot");
      if (vision) {
        expect(payload.messages[5]).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "Image from Tool image-call:" }, { type: "image_url" }],
        });
      } else {
        expect(payload.messages).toHaveLength(5);
        expect(JSON.stringify(payload)).toContain("model does not support images");
      }
    },
  );

  it("decodes UTF-8 embedded text rather than sending base64 to the model", async () => {
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        }),
      ),
    );
    const input = request();
    input.messages = [
      {
        role: "user",
        content: [
          {
            type: "resource",
            resource: {
              uri: "attachment:///notes.txt",
              mimeType: "text/plain;charset=utf-8",
              blob: Buffer.from("中文笔记").toString("base64"),
            },
          },
        ],
      },
    ];
    await new OpenAICompatibleModel({ fetchFn }).complete(input);
    expect(bodyText(fetchFn.mock.calls[0]?.[1])).toContain("中文笔记");
    expect(bodyText(fetchFn.mock.calls[0]?.[1])).not.toContain("Base64:");
  });

  it("keeps local content errors distinct from network availability", async () => {
    const fetchFn = vi.fn();
    const input = request();
    input.messages = [
      { role: "user", content: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }] },
    ];
    await expect(new OpenAICompatibleModel({ fetchFn }).complete(input)).rejects.toMatchObject({
      code: "model_unsupported_content",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

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
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
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
      usage: {},
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

function request(): AuthenticatedModelRequest {
  return {
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
