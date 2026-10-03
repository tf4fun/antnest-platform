import { TestRequest as Request } from "../../../services/agent-ui/web/server/test/support/auth-fixture.ts";
import assert from "node:assert/strict";
import inspector from "node:inspector";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWorkspaceRuntime } from "../../../services/agent-ui/web/server/src/workspace-runtime.ts";

const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
};
const base = "http://localhost/api/app/workspace/v1/agents/agent-1";
const sizes = [8 * 1024, 256 * 1024, 1024 * 1024];

function sampledBytes(profile) {
  let bytes = 0;
  const visit = (node) => {
    bytes += node.selfSize;
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile.head);
  return bytes;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function sample(bodySize, negativeControl = false) {
  let update;
  let watermark = 0;
  const runtime = createWorkspaceRuntime({
    connect: async (_scope, callbacks) => {
      update = callbacks.update;
      return {
        async readAgentExecutionState() {
          return { availability: "ready", activeSessionId: null };
        },
        async load() {
          return { cut: { sealedWatermark: 0, appendVersion: 1 } };
        },
        async readExecution(sessionId) {
          return {
            sessionId,
            appendVersion: 1,
            outputWatermark: watermark,
            activeRunId: "run-1",
            recentReceipts: [],
            configurationRevision: null,
          };
        },
        async readIntent() {
          return { kind: "unknown" };
        },
        async prompt() {},
        async cancel() {},
        close() {},
      };
    },
  });
  const readers = [];
  const controllers = [];
  const request = (path, signal) =>
    runtime.handle(
      new Request(`${base}${path}`, { headers, ...(signal ? { signal } : {}) }),
    );
  async function view() {
    const response = await request("/view?sessionId=session-1");
    assert.equal(response?.status, 200);
    return response.json();
  }
  function deliver(sequence, messageId, payload) {
    watermark = sequence;
    update({
      sessionId: "session-1",
      update: payload,
      _meta: {
        "antnest.dev/delivery": {
          kind: "part",
          sequence,
          partIndex: 0,
          partCount: 1,
          runId: "run-1",
          messageId,
        },
      },
    });
  }
  try {
    await view();
    const body = `start 界\\\"\n${"x".repeat(bodySize)}\nend`;
    deliver(1, "large", {
      sessionUpdate: "tool_call",
      toolCallId: "large",
      title: "Large",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: body } }],
    });
    deliver(2, "small", {
      sessionUpdate: "tool_call",
      toolCallId: "small",
      title: "Small",
      status: "in_progress",
      content: [
        { type: "content", content: { type: "text", text: "original" } },
      ],
    });
    deliver(3, "answer", {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "small message:" },
    });
    const initial = await view();
    assert.equal(initial.selectedView.turns[0]?.processCount, 2);
    for (let index = 0; index < 4; index++) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await request(
        `/events?sessionId=session-1&cursor=${encodeURIComponent(initial.streamCursor)}`,
        controller.signal,
      );
      assert.equal(response?.status, 200);
      readers.push(response.body.getReader());
    }
    global.gc();
    const before = process.memoryUsage();
    const profiler = new inspector.Session();
    profiler.connect();
    const post = promisify(profiler.post.bind(profiler));
    let viewBytes = 0;
    let frameBytes = 0;
    const controlCopies = [];
    let profile;
    try {
      await post("HeapProfiler.enable");
      await post("HeapProfiler.startSampling", { samplingInterval: 512 });
      for (let step = 0; step < 8; step++) {
        deliver(step + 4, `small-${step}`, {
          sessionUpdate: "tool_call_update",
          toolCallId: "small",
          title: `Small ${step}`,
          status: "in_progress",
          content: [
            {
              type: "content",
              content: { type: "text", text: `small output ${step}` },
            },
          ],
        });
        const frames = await Promise.all(
          readers.map(async (reader) => {
            const result = await reader.read();
            assert.equal(result.done, false);
            return result.value;
          }),
        );
        for (const frame of frames) {
          assert.ok(
            frame.length < 128 * 1024,
            "Unrelated tool body leaked into SSE",
          );
          frameBytes += frame.length;
        }
        const response = await request("/view?sessionId=session-1");
        assert.equal(response?.status, 200);
        const wire = await response.text();
        viewBytes += Buffer.byteLength(wire);
        assert.ok(
          wire.length < 128 * 1024,
          "Unrelated tool body leaked into View",
        );
        assert.equal(JSON.parse(wire).selectedView.turns[0]?.processCount, 2);
        if (negativeControl) controlCopies.push(JSON.stringify({ body, step }));
      }
      ({ profile } = await post("HeapProfiler.stopSampling"));
    } finally {
      profiler.disconnect();
    }
    global.gc();
    const after = process.memoryUsage();
    if (negativeControl) assert.equal(controlCopies.length, 8);
    return {
      bodySize,
      viewBytes,
      frameBytes,
      sampledAllocatedBytes: sampledBytes(profile),
      heapRetainedDeltaBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
    };
  } finally {
    controllers.forEach((controller) => controller.abort());
    await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
    await runtime.drain(1_000);
    assert.equal(runtime.metrics().owners, 0);
  }
}

test("HTTP View and four SSE observers omit unrelated large tool bodies during small updates", async () => {
  assert.equal(typeof global.gc, "function", "Run with --expose-gc");
  const trials = sizes.map(() => []);
  for (let trial = 0; trial < 3; trial++)
    for (let offset = 0; offset < sizes.length; offset++) {
      const index = (trial + offset) % sizes.length;
      trials[index].push(await sample(sizes[index]));
    }
  const results = sizes.map((bodySize, index) => ({
    bodySize,
    viewBytes: median(trials[index].map((value) => value.viewBytes)),
    frameBytes: median(trials[index].map((value) => value.frameBytes)),
    sampledAllocatedBytes: median(
      trials[index].map((value) => value.sampledAllocatedBytes),
    ),
    heapRetainedDeltaBytes: median(
      trials[index].map((value) => value.heapRetainedDeltaBytes),
    ),
    rssDeltaBytes: median(trials[index].map((value) => value.rssDeltaBytes)),
  }));
  for (const entry of results.slice(1)) {
    assert.ok(entry.viewBytes <= results[0].viewBytes + 128 * 1024);
    assert.ok(entry.frameBytes <= results[0].frameBytes + 128 * 1024);
    assert.ok(
      entry.sampledAllocatedBytes <=
        results[0].sampledAllocatedBytes + 512 * 1024,
      `HTTP/SSE allocation grew with an unrelated ${entry.bodySize}-byte body: ${JSON.stringify(results)}`,
    );
    assert.ok(
      entry.heapRetainedDeltaBytes <=
        results[0].heapRetainedDeltaBytes + 512 * 1024,
      `HTTP/SSE retained heap grew with an unrelated ${entry.bodySize}-byte body: ${JSON.stringify(results)}`,
    );
  }
  const negativeControl = await sample(sizes[2], true);
  assert.ok(
    negativeControl.sampledAllocatedBytes >
      results[2].sampledAllocatedBytes + 1024 * 1024,
    `Profiler missed repeated 1 MiB serialization: ${JSON.stringify(negativeControl)}`,
  );
  process.stdout.write(`${JSON.stringify({ results, negativeControl })}\n`);
});
