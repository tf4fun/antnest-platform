import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { applyAgentDelta } from "../../../services/agent-ui/web/server/dist/protocol/agent-view-delta.js";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/dist/workspace-runtime.js";
import { createWorkspaceHttpServer } from "../../../services/agent-ui/web/server/dist/http/node-server.js";

const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};

function notice(changeId, sequence, title) {
  return {
    sessionId: "uncached-session",
    update: {
      sessionUpdate: "notice",
      severity: "info",
      title,
      description: "Skill learning result saved.",
      _meta: {
        "antnest.dev/skill-learning": {
          version: 1,
          changeId,
          sequence,
          agentId: "agent-1",
          kind: sequence === "1" ? "skill_created" : "skill_updated",
          occurredAt:
            sequence === "1" ? "2026-09-29T00:00:00Z" : "2026-09-29T00:01:00Z",
          skillName: "workflow",
          changeSummary: title,
        },
      },
    },
  };
}

async function nextDelta(reader, state) {
  for (;;) {
    while (!state.buffer.includes("\n\n")) {
      let part;
      try {
        part = await reader.read();
      } catch (error) {
        throw new Error(
          `SSE read failed after ${JSON.stringify(state.buffer.slice(0, 500))}`,
          { cause: error },
        );
      }
      assert.equal(part.done, false, "SSE closed before the learning delta");
      state.buffer += new TextDecoder()
        .decode(part.value)
        .replaceAll("\r\n", "\n");
    }
    const end = state.buffer.indexOf("\n\n");
    const frame = state.buffer.slice(0, end);
    state.buffer = state.buffer.slice(end + 2);
    if (!frame.includes("event: delta")) continue;
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    assert(data);
    return JSON.parse(data.slice(6));
  }
}

test("Agent SSE keeps late Skill notices in sequence order without duplicate history", async () => {
  let update;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => {
      update = callbacks.update;
      return {
        async readAgentExecutionState() {
          return { availability: "ready", activeSessionId: null };
        },
        async watchAgentExecutionState(onState, signal) {
          onState({ availability: "ready", activeSessionId: null });
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        },
        async load() {
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: 1,
            outputWatermark: 0,
            activeRunId: null,
            recentReceipts: [],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {
          return { stopReason: "end_turn" };
        },
        async cancel() {},
        close() {},
      };
    },
  });
  const server = createWorkspaceHttpServer(runtime);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const abort = new AbortController();
  let reader;
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1`;
    let view = await (
      await fetch(`${base}/view?sessionId=session-1`, { headers })
    ).json();
    assert.deepEqual(view.systemNotices, []);
    const response = await fetch(
      `${base}/events?sessionId=session-1&cursor=${encodeURIComponent(view.streamCursor)}`,
      {
        headers,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
      },
    );
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    const frames = { buffer: "" };

    await update(notice("change-2", "2", "Improved the workflow"));
    const live = await (
      await fetch(`${base}/view?sessionId=session-1`, { headers })
    ).json();
    assert.deepEqual(
      live.systemNotices.map((item) => item.changeId),
      ["change-2"],
    );
    view = applyAgentDelta(view, await nextDelta(reader, frames));
    assert(view);
    assert.deepEqual(
      view.systemNotices.map((item) => item.changeId),
      ["change-2"],
    );

    await update(notice("change-1", "1", "Learned the workflow"));
    view = applyAgentDelta(view, await nextDelta(reader, frames));
    assert(view);
    assert.deepEqual(
      view.systemNotices.map((item) => item.changeId),
      ["change-1", "change-2"],
    );

    await update(notice("change-1", "1", "Learned the workflow"));
    const refreshed = await (
      await fetch(`${base}/view?sessionId=session-1`, { headers })
    ).json();
    assert.deepEqual(
      refreshed.systemNotices.map((item) => item.changeId),
      ["change-1", "change-2"],
    );
    abort.abort();
    await reader.cancel().catch(() => undefined);
    assert.deepEqual(await runtime.drain(1_000), { forced: false });
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => undefined);
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
