import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { TestRequest as Request } from "./support/auth-fixture.ts";
import { createWorkspaceRuntime } from "../src/workspace-runtime.ts";
import {
  applyBridgeEvent,
  initialBridgeStream,
  type BridgeAgentView,
} from "../../src/lib/bridge-stream.ts";

const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};
const agent = "http://localhost/api/app/workspace/v1/agents/agent-1";
const session = `${agent}/sessions/session-1`;

for (const { parts, buffered, concurrent } of [
  { parts: 1, buffered: false },
  { parts: 2, buffered: false },
  { parts: 1, buffered: true },
  { parts: 1, buffered: false, concurrent: true },
]) {
  test(`complete user delivery reconciles held prompt acceptance (${parts} parts, buffered=${buffered}, concurrent=${!!concurrent})`, async () => {
    const userSequence = buffered ? 2 : 1;
    const held = Promise.withResolvers<void>();
    const oldIntent = Promise.withResolvers<void>();
    const oldReadStarted = Promise.withResolvers<void>();
    let holdOldRead = false;
    let priorRead: Promise<Response | undefined> | undefined;
    let update!: (value: SessionNotification) => void | Promise<void>;
    let admitted = false;
    let finished = false;
    let promptStarted = false;
    let executionReads = 0;
    let precommitIntentReads = 0;
    let loads = 0;
    const receipt = () => ({
      sessionId: "session-1",
      intentId: "intent-1",
      runId: "run-1",
      phase: finished ? ("completed" as const) : ("running" as const),
      appendVersion: 2,
      outputWatermark: userSequence,
      stopReason: finished ? "end_turn" : null,
      errorClass: null,
    });
    const runtime = createWorkspaceRuntime({
      connect: async (_scope, callbacks) => {
        update = callbacks.update;
        return {
          async readAgentExecutionState() {
            return { availability: "ready" as const, activeSessionId: null };
          },
          async load() {
            loads++;
            assert.equal(
              loads,
              1,
              "complete live delivery must not need replay",
            );
            return { cut: { sealedWatermark: 0, appendVersion: 1 } };
          },
          async readExecution(sessionId) {
            executionReads++;
            return {
              sessionId,
              appendVersion: admitted ? 2 : 1,
              outputWatermark: admitted ? userSequence : 0,
              activeRunId: admitted && !finished ? "run-1" : null,
              recentReceipts: admitted ? [receipt()] : [],
              configurationRevision: null,
            };
          },
          async readIntent() {
            if (admitted)
              return { kind: "receipt" as const, receipt: receipt() };
            precommitIntentReads++;
            if (holdOldRead) {
              holdOldRead = false;
              oldReadStarted.resolve();
              await oldIntent.promise;
            }
            return { kind: "unknown" as const };
          },
          async prompt() {
            promptStarted = true;
            await held.promise;
          },
          async cancel() {},
          close() {},
        };
      },
    });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let state = initialBridgeStream("agent-1", "session-1");
    const views: BridgeAgentView[] = [];
    const decoder = new TextDecoder();
    let buffer = "";
    async function observe(predicate: (view: BridgeAgentView) => boolean) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async () => {
        for (;;) {
          const match = views.find(predicate);
          if (match) return match;
          const chunk = await reader!.read();
          assert.equal(chunk.done, false, "SSE ended before acceptance");
          buffer += decoder.decode(chunk.value, { stream: true });
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const next = applyBridgeEvent(state, JSON.parse(data));
            assert.ok(
              next.action === "view" || next.action === "ignore",
              "live SSE must not require an HTTP refresh",
            );
            state = next.state;
            if (next.action === "view") views.push(state.view!);
          }
        }
      };
      try {
        return await Promise.race([
          read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "held prompt acceptance did not reach SSE after user delivery",
                  ),
                ),
              1_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      const stream = await runtime.handle(
        new Request(`${agent}/events?sessionId=session-1`, {
          headers,
          signal: abort.signal,
        }),
      );
      assert.equal(stream?.status, 200);
      reader = stream!.body!.getReader();
      const initial = await observe((view) => view.selectedView !== null);
      const response = await runtime.handle(
        new Request(`${session}/prompts`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "idempotency-key": "intent-1",
            "if-match": initial.selectedView!.historyToken!,
          },
          body: JSON.stringify({
            intentId: "intent-1",
            expectedAppendVersion: 1,
            prompt: [{ type: "text", text: "held request" }],
          }),
        }),
      );
      assert.equal(response?.status, 202);
      // This event is published after the submit-triggered reconciliation read
      // the old execution snapshot and found no durable intent receipt.
      const dispatching = await observe((view) =>
        view.operations.some(
          (op) => op.operationId === "intent-1" && op.acceptance === "bridge",
        ),
      );
      assert.equal(dispatching.operations[0]?.phase, "dispatching");
      assert.ok(precommitIntentReads > 0);
      assert.equal(promptStarted, true);
      if (concurrent) {
        holdOldRead = true;
        priorRead = runtime.handle(new Request(`${session}/view`, { headers }));
        await oldReadStarted.promise;
      }
      const beforeDelivery = executionReads;
      admitted = true;
      const notification = (partIndex: number): SessionNotification => ({
        sessionId: "session-1",
        update: {
          sessionUpdate: "user_message_chunk",
          content: {
            type: "text",
            text: partIndex === 0 ? "held" : " request",
          },
        },
        _meta: {
          "antnest.dev/delivery": {
            kind: "part",
            sequence: userSequence,
            partIndex,
            partCount: parts,
            runId: "run-1",
            messageId: "input-1",
          },
        },
      });
      for (let part = 0; part < parts; part++) {
        await update(notification(part));
        if (part + 1 < parts) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(
            executionReads,
            beforeDelivery,
            "partial delivery must not trigger receipt reconciliation",
          );
        }
      }
      if (buffered) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          executionReads,
          beforeDelivery,
          "buffered input must not reconcile before its gap is closed",
        );
        await update({
          sessionId: "session-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
          _meta: {
            "antnest.dev/delivery": { kind: "checkpoint", sequence: 1 },
          },
        });
      }
      if (concurrent) {
        // Let delivery reconciliation join the already-running GET. Its intent
        // result remains the precommit unknown even though delivery is complete.
        await new Promise<void>((resolve) => setImmediate(resolve));
        oldIntent.resolve();
        assert.equal((await priorRead)?.status, 200);
      }
      // No new GET, Agent-state event, model output or prompt completion may wake it.
      const accepted = await observe((view) =>
        view.operations.some(
          (op) => op.operationId === "intent-1" && op.acceptance === "acp",
        ),
      );
      assert.equal(accepted.operations[0]?.runId, "run-1");
      assert.equal(accepted.operations[0]?.phase, "running");
      assert.equal(accepted.operations[0]?.outputWatermark, userSequence);
      assert.equal(accepted.selectedView?.appendVersion, 2);
      assert.equal(accepted.selectedView?.outputWatermark, userSequence);
      assert.equal(finished, false);
      assert.equal(loads, 1);
      assert.equal(executionReads, beforeDelivery + 1);
      const afterAcceptance = executionReads;
      if (buffered)
        await update({
          sessionId: "session-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [],
          },
          _meta: {
            "antnest.dev/delivery": { kind: "checkpoint", sequence: 1 },
          },
        });
      await update(notification(parts - 1));
      await update({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "later output" },
        },
        _meta: {
          "antnest.dev/delivery": {
            kind: "part",
            sequence: userSequence + 1,
            partIndex: 0,
            partCount: 1,
            runId: "run-1",
            messageId: "output-1",
          },
        },
      });
      await observe(
        (view) => view.selectedView?.outputWatermark === userSequence + 1,
      );
      assert.equal(
        executionReads,
        afterAcceptance,
        "duplicate input and ordinary output must keep using cached receipts",
      );
    } finally {
      oldIntent.resolve();
      await priorRead?.catch(() => {});
      abort.abort();
      await reader?.cancel();
      reader?.releaseLock();
      finished = true;
      held.resolve();
      await runtime.drain(1_000);
      assert.equal(runtime.metrics().heldWork, 0);
      assert.equal(runtime.metrics().streamSubscribers, 0);
    }
  });
}
