import { syntheticProviderDestination } from "../../support/model-network.js";
import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import type { ModelDelta, AuthenticatedModelRequest } from "../../../src/ports/model.js";
import { snapshot } from "../../support/fixtures.js";

function input(onDelta = vi.fn<(delta: ModelDelta) => Promise<void>>(() => Promise.resolve())) {
  return {
    snapshot: snapshot(),
    credential: "synthetic",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    onDelta,
  } satisfies AuthenticatedModelRequest;
}

function stream() {
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writer = source.writable.getWriter();
  const fetchFn = vi.fn(() =>
    Promise.resolve(
      new Response(source.readable, { headers: { "content-type": "text/event-stream" } }),
    ),
  );
  return {
    model: new OpenAICompatibleModel({ destination: syntheticProviderDestination, fetchFn }),
    fetchFn,
    writer,
    async send(data: unknown) {
      await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
    },
  };
}

function chunk(delta: unknown, finish: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
}

describe("OpenAI streaming completions", () => {
  it.each([
    chunk({ content: "late" }, "stop"),
    chunk(
      { tool_calls: [{ index: 0, id: "late", function: { name: "bash", arguments: "{}" } }] },
      "stop",
    ),
    chunk({}, "length"),
  ])("rejects changed output or finish reasons in a usage tail: %j", async (tail) => {
    const payload =
      [
        chunk({ content: "done" }, "stop"),
        { ...tail, usage: { prompt_tokens: 7, completion_tokens: 3 } },
      ]
        .map((part) => `data: ${JSON.stringify(part)}\n\n`)
        .join("") + "data: [DONE]\n\n";
    const model = new OpenAICompatibleModel({
      destination: syntheticProviderDestination,
      fetchFn: () =>
        Promise.resolve(
          new Response(payload, { headers: { "content-type": "text/event-stream" } }),
        ),
    });
    await expect(model.complete(input())).rejects.toMatchObject({ code: "model_invalid_response" });
  });
  it.each(["", null, undefined])(
    "keeps empty reasoning %s distinct from an absent field",
    async (reasoning) => {
      const payload = `data: ${JSON.stringify(chunk({ ...(reasoning === undefined ? {} : { reasoning_content: reasoning }), tool_calls: [{ index: 0, id: "read", function: { name: "read", arguments: "{}" } }] }, "tool_calls"))}\n\ndata: [DONE]\n\n`;
      const model = new OpenAICompatibleModel({
        destination: syntheticProviderDestination,
        fetchFn: () =>
          Promise.resolve(
            new Response(payload, { headers: { "content-type": "text/event-stream" } }),
          ),
      });
      const result = await model.complete(input());
      expect(result.thought).toEqual(
        reasoning === undefined ? undefined : [{ type: "text", text: "" }],
      );
    },
  );
  it("delivers thought and text before completion, then consumes trailing usage without duplicates", async () => {
    const source = stream();
    const request = input();
    let settled = false;
    const completed = source.model.complete(request).finally(() => {
      settled = true;
    });
    const observed = completed.catch(() => undefined);
    try {
      await source.send(chunk({ reasoning_content: "inspect" }));
      await vi.waitFor(() =>
        expect(request.onDelta).toHaveBeenCalledWith({ kind: "thought", text: "inspect" }),
      );
      expect(settled).toBe(false);
      await source.send(chunk({ content: "hello" }));
      await source.send(chunk({}, "stop"));
      await source.send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
      await source.writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
      expect(await completed).toEqual({
        kind: "message",
        content: [{ type: "text", text: "hello" }],
        thought: [{ type: "text", text: "inspect" }],
        usage: { inputTokens: 7, outputTokens: 3 },
        stopReason: "end_turn",
      });
      expect(request.onDelta.mock.calls.map(([delta]) => delta)).toEqual([
        { kind: "thought", text: "inspect" },
        { kind: "message", text: "hello" },
      ]);
    } finally {
      await source.writer.abort().catch(() => undefined);
      await observed;
    }
  });

  it("decodes split UTF-8, comments and CRLF framing using the SSE parser", async () => {
    const bytes = new TextEncoder().encode(
      `: ping\r\n\r\ndata: ${JSON.stringify(chunk({ content: "你好" }))}\r\n\r\ndata: ${JSON.stringify(chunk({}, "stop"))}\r\n\r\ndata: [DONE]\r\n\r\n`,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    );
    const request = input();
    expect(
      await new OpenAICompatibleModel({
        destination: syntheticProviderDestination,
        fetchFn,
      }).complete(request),
    ).toMatchObject({
      content: [{ type: "text", text: "你好" }],
      stopReason: "end_turn",
    });
    const bodyText = fetchFn.mock.calls[0]?.[1].body;
    if (typeof bodyText !== "string") throw new Error("Missing request JSON");
    expect(JSON.parse(bodyText) as unknown).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("assembles indexed Tool fragments only after a complete Tool finish reason", async () => {
    const source = stream();
    const completed = source.model.complete(input());
    const observed = completed.catch(() => undefined);
    try {
      await source.send(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "read", arguments: '{"pa' },
            },
          ],
        }),
      );
      await source.send(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }));
      await source.send(chunk({}, "tool_calls"));
      await source.writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
      expect(await completed).toMatchObject({
        kind: "tool_calls",
        calls: [{ id: "call-1", name: "read", arguments: { path: "a" } }],
      });
    } finally {
      await source.writer.abort().catch(() => undefined);
      await observed;
    }
  });

  it.each(["eof", "done", "error"])(
    "rejects %s without a valid completion after partial output",
    async (ending) => {
      const source = stream();
      const request = input();
      const completed = source.model.complete(request);
      const rejected = expect(completed).rejects.toMatchObject({ code: "model_invalid_response" });
      await source.send(chunk({ content: "partial" }));
      if (ending === "done")
        await source.writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
      else if (ending === "error") await source.send({ error: { message: "synthetic failure" } });
      else await source.writer.close();
      await rejected;
      expect(request.onDelta).toHaveBeenCalledWith({ kind: "message", text: "partial" });
      await source.writer.abort().catch(() => undefined);
    },
  );

  it("cancels an idle body reader and never emits a late delta", async () => {
    const source = stream();
    const controller = new AbortController();
    const request = { ...input(), signal: controller.signal };
    const completed = source.model.complete(request);
    const rejected = expect(completed).rejects.toBeDefined();
    await source.send(chunk({ content: "partial" }));
    controller.abort();
    await rejected;
    await expect(source.send(chunk({ content: "late" }))).rejects.toBeDefined();
    expect(request.onDelta.mock.calls.map(([delta]) => delta.text)).toEqual(["partial"]);
  });

  it("does not return partially assembled Tools on a length limit", async () => {
    const source = stream();
    const completed = source.model.complete(input());
    await source.send(
      chunk({
        content: "partial",
        tool_calls: [{ index: 0, id: "call", function: { name: "write", arguments: '{"path":' } }],
      }),
    );
    await source.send(chunk({}, "length"));
    await source.writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
    await expect(completed).resolves.toMatchObject({
      kind: "message",
      stopReason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
    });
    await source.writer.abort().catch(() => undefined);
  });
});
