import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  temporaryStorageRoot,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { workspaceOutageFixture } from "../workspace-closeout/chat-fixtures.mjs";

test("offline cancellation replay retains original bytes, linked sources and raw strict findings", async (t) => {
  const { replayOutageCancellation } =
    await import("./resolve-cache-outage-replay.mjs");
  const root = mkdtempSync(join(temporaryStorageRoot(), "outage-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input"),
    output = join(root, "output");
  const f = workspaceOutageFixture("shared");
  f.trace.warnings = ["raw-warning"];
  const files = new Map();
  const write = (name, value) => {
    const text = JSON.stringify(value);
    writeEvidenceFile(
      join(input, name.includes("/") ? "outage-traces" : ""),
      name.split("/").at(-1),
      text,
    );
    files.set(name, text);
  };
  for (const [id, trace] of f.traces) write(`outage-traces/${id}.json`, trace);
  write("outage-trace-archive.json", {
    status: "raw_closures_archived_owning_admission_pending",
    archived_trace_ids: [...f.traces.keys()],
  });
  write("outage-window.private.json", {
    agent_id: "agent",
    session_id: "session",
    run_id: "run-id",
    settings: { resolveTTLMS: 10000 },
    cancel_at: f.expected.cancelAt,
    audit: f.expected.audit,
    model_cancelled: { state: { requests: f.expected.requests, errors: [] } },
    http: [
      f.expected.audit,
      {
        label: "outage-prompt",
        method: "POST",
        path: "/api/app/workspace/v1/agents/agent/sessions/session/prompts",
        trace_id: f.trace.traceID,
        status: 202,
        set_cookie_count: 0,
        body: { acceptance: "bridge" },
      },
    ],
  });
  const result = await replayOutageCancellation(input, output);
  assert.equal(result.evidence_kind, "offline_replay_not_new_docker_execution");
  assert.equal(result.cancellation.settled_read, true);
  assert.equal(result.cancellation.error_spans, 2);
  assert.equal(result.cancellation.warning_count, 1);
  assert.equal(result.cancellation.strict_trace, "failed");
  assert.equal(result.source_files.length, files.size);
  for (const [name, before] of files)
    assert.equal(readFileSync(join(input, name), "utf8"), before);
  await assert.rejects(replayOutageCancellation(input, input), /unused/u);
  await assert.rejects(replayOutageCancellation(input, output), /unused/u);
});
