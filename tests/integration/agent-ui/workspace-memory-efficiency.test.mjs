import assert from "node:assert/strict";
import inspector from "node:inspector";
import { test } from "node:test";
import { promisify } from "node:util";
import { CompactTranscript } from "../../../services/agent-ui/web/server/src/bridge/compact-transcript.ts";
import { ViewPager } from "../../../services/agent-ui/web/server/src/bridge/view-pager.ts";

const sizes = [8 * 1024, 256 * 1024, 1024 * 1024];
// V8's sampling profile estimates allocation traffic; it is not Rust's exact
// System allocator counter. Median trials and a 128 KiB comparison margin
// reject a body-sized regression while tolerating profiler/JIT variation.
// GC-retained heap is gated separately; RSS is reported as diagnostic evidence.
const context = { organizationId: "org", principalId: "user", agentId: "agent",
  sessionId: "session", epoch: "epoch", incarnation: "incarnation", watermark: 1 };
const key = Buffer.alloc(32, 4);

function batch(sequence, messageId, update) {
  return { sequence, runId: "run", messageId, updates: [update] };
}

function fixture(bodySize) {
  const transcript = new CompactTranscript();
  const body = `start 界\\\"\n${"x".repeat(bodySize)}\nend`;
  transcript.apply(batch(1, "large", { sessionUpdate: "tool_call",
    toolCallId: "large", title: "Large", status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: body } }] }));
  transcript.apply(batch(2, "small", { sessionUpdate: "tool_call",
    toolCallId: "small", title: "Small", status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "original" } }] }));
  transcript.apply(batch(3, "answer", { sessionUpdate: "agent_message_chunk",
    messageId: "answer", content: { type: "text", text: "small message:" } }));
  transcript.setOutcome("run", "running");
  const held = transcript.turns();
  const heldWire = JSON.stringify(held);
  let pager = new ViewPager({ transcript, context, key });
  const heldView = pager.recentTurns();
  return { transcript, held, heldWire, heldView, pager, body };
}

function sampleBytes(profile) {
  let bytes = 0;
  const visit = (node) => {
    bytes += node.selfSize;
    for (const child of node.children ?? []) visit(child);
  };
  visit(profile.head);
  return bytes;
}

async function sample(bodySize, kind, negativeControl = false) {
  const work = fixture(bodySize);
  global.gc();
  const before = process.memoryUsage();
  const session = new inspector.Session();
  session.connect();
  const post = promisify(session.post.bind(session));
  const controlCopies = [];
  let profile;
  try {
    await post("HeapProfiler.enable");
    await post("HeapProfiler.startSampling", { samplingInterval: 512 });
    for (let step = 0; step < 8; step++) {
      const update = kind === "tool" ? { sessionUpdate: "tool_call_update",
        toolCallId: "small", title: `Small ${step}`, status: step === 7 ? "completed" : "in_progress",
        content: [{ type: "content", content: { type: "text", text: `small output ${step}` } }] }
        : { sessionUpdate: "agent_message_chunk", messageId: "answer",
          content: { type: "text", text: ` ${step}` } };
      work.transcript.apply(batch(step + 4, `update-${step}`, update));
      work.pager = new ViewPager({ transcript: work.transcript,
        context: { ...context, watermark: step + 2 }, key,
        turnContentCache: work.pager.sharedTurnContentCache() });
      const current = work.pager.recentTurns().items[0];
      assert.equal(current.processCount, 2);
      assert.equal(current.outcome, "running");
      assert.ok(work.transcript.estimatedRetainedBytes >= bodySize);
      if (negativeControl) controlCopies.push(JSON.stringify({ body: work.body, step }));
    }
    ({ profile } = await post("HeapProfiler.stopSampling"));
  } finally {
    session.disconnect();
  }
  const beforeGc = process.memoryUsage();
  global.gc();
  const afterGc = process.memoryUsage();
  assert.equal(JSON.stringify(work.held), work.heldWire);
  if (negativeControl) assert.equal(controlCopies.length, 8);
  assert.equal(work.heldView.items[0]?.processCount, 2);
  const currentLarge = work.transcript.turns()[0]?.process[0]?.content[0];
  assert.equal(currentLarge?.type, "text");
  assert.equal(currentLarge?.text, work.body);
  return { sampledAllocatedBytes: sampleBytes(profile),
    heapPeakDeltaBytes: beforeGc.heapUsed - before.heapUsed,
    heapRetainedDeltaBytes: afterGc.heapUsed - before.heapUsed,
    rssDeltaBytes: afterGc.rss - before.rss };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

test("small transcript updates do not allocate in proportion to unrelated tool bodies", async () => {
  assert.equal(typeof global.gc, "function", "Run with --expose-gc");
  const results = {};
  for (const kind of ["tool", "message"]) {
    const trialsBySize = sizes.map(() => []);
    for (let trial = 0; trial < 3; trial++)
      for (let offset = 0; offset < sizes.length; offset++) {
        const index = (trial + offset) % sizes.length;
        trialsBySize[index].push(await sample(sizes[index], kind));
      }
    results[kind] = sizes.map((bodySize, index) => {
      const trials = trialsBySize[index];
      return { bodySize, sampledAllocatedBytes:
        median(trials.map((value) => value.sampledAllocatedBytes)),
        heapRetainedDeltaBytes: median(trials.map((value) => value.heapRetainedDeltaBytes)),
        rssDeltaBytes: median(trials.map((value) => value.rssDeltaBytes)) };
    });
    const baseline = results[kind][0].sampledAllocatedBytes;
    for (const entry of results[kind].slice(1))
      assert.ok(entry.sampledAllocatedBytes <= baseline + 128 * 1024,
        `${kind} allocation sampling grew with an unrelated ${entry.bodySize}-byte body: ${JSON.stringify(results[kind])}`);
    const retainedBaseline = results[kind][0].heapRetainedDeltaBytes;
    for (const entry of results[kind].slice(1))
      assert.ok(entry.heapRetainedDeltaBytes <= retainedBaseline + 256 * 1024,
        `${kind} retained heap grew with an unrelated ${entry.bodySize}-byte body: ${JSON.stringify(results[kind])}`);
  }
  const control = await sample(sizes[2], "tool", true);
  assert.ok(control.sampledAllocatedBytes > results.tool[2].sampledAllocatedBytes + 1024 * 1024,
    `Allocation profiler did not detect the 1 MiB repeated-serialization control: ${JSON.stringify(control)}`);
  process.stdout.write(`${JSON.stringify({ samples: results, negativeControl: control })}\n`);
});
