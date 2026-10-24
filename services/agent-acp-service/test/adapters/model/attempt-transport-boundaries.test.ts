import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModel } from "../../../src/adapters/model/openai-compatible.js";
import { PinnedProviderTransport } from "../../../src/adapters/model/provider-transport.js";
import { ModelError, ModelTransportCleanupError } from "../../../src/ports/model.js";
import { snapshot } from "../../support/fixtures.js";

function causes(error: unknown): unknown[] {
  return [
    error,
    ...(error instanceof AggregateError ? error.errors.flatMap(causes) : []),
    ...(error instanceof Error && Object.hasOwn(error, "cause") ? causes(error.cause) : []),
  ];
}

describe("actual Provider transport completion boundary", () => {
  it.each([
    "success-close-failure",
    "callback-failure",
    "late-abort",
    "late-abort-close-failure",
  ] as const)("joins the original dispatcher and retains observations during %s", async (mode) => {
    const gate = Promise.withResolvers<void>();
    const enteredClose = Promise.withResolvers<void>();
    const operationError = new Error("original output callback failed");
    const closeError = new Error("original transport close failed");
    const abortError = new Error("Run cancelled during transport close");
    const controller = new AbortController();
    const sockets = new Set<Socket>();
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`;
    const output = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "visible" }, finish_reason: "stop" }] })}\n\n`;
    const server = createServer((incoming, response) => {
      incoming.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "callback-failure") response.write(usage + output);
      else response.end(usage + output + "data: [DONE]\n\n");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with the exact original instance below.
    const originalClose = PinnedProviderTransport.prototype.close;
    const close = vi
      .spyOn(PinnedProviderTransport.prototype, "close")
      .mockImplementation(async function (this: PinnedProviderTransport) {
        enteredClose.resolve();
        await gate.promise;
        await originalClose.call(this);
        if (mode !== "late-abort") throw closeError;
      });
    let observed: Promise<unknown> | undefined;
    let settled = false;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      const frozen = snapshot();
      frozen.executionSpec.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const model = new OpenAICompatibleModel({ destination: { allowPrivateEndpoints: true } });
      const completed = model
        .complete({
          snapshot: frozen,
          credential: "synthetic",
          tools: [],
          messages: [],
          signal: controller.signal,
          ...(mode === "callback-failure" ? { onDelta: () => Promise.reject(operationError) } : {}),
        })
        .finally(() => {
          settled = true;
        });
      observed = completed.catch((caught: unknown) => caught);
      await enteredClose.promise;
      expect(settled).toBe(false);
      if (mode.startsWith("late-abort")) controller.abort(abortError);
      gate.resolve();
      const error: unknown = await observed;
      expect(error).toBeInstanceOf(mode === "late-abort" ? ModelError : ModelTransportCleanupError);
      expect(error).toMatchObject({
        outputStarted: true,
        usage: { inputTokens: 7, outputTokens: 2 },
      });
      if (mode !== "late-abort") expect(causes(error)).toContain(closeError);
      if (mode === "callback-failure") expect(causes(error)).toContain(operationError);
      if (mode.startsWith("late-abort")) expect(causes(error)).toContain(abortError);
      expect(close).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      gate.resolve();
      await observed;
      close.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
