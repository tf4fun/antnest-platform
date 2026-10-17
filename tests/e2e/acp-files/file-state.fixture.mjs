import { createHash } from "node:crypto";
import { cases } from "./model.mjs";

// Synthetic protocol fixtures; actual checkpoints are built from model receipts.
export function fileStateFixture() {
  const agents = ["agent-one", "agent-two"];
  const executions = [];
  const requests = [];
  for (const version of [1, 2])
    for (const [index, item] of cases.entries()) {
      const phase = `v${version}-${item.id}`;
      const toolCallId = createHash("sha256")
        .update(JSON.stringify([`fixture-run:${phase}`, 0, phase]))
        .digest("hex");
      const trace_id = (version * 16 + index).toString(16).padStart(32, "0");
      executions.push({
        phase,
        agentId: agents[version - 1],
        protocolVersion: version,
        toolCallId,
      });
      for (const [offset, stage] of ["tool", "final"].entries())
        requests.push({
          phase,
          stage,
          trace_id,
          model_span_id: (version * 32 + index * 2 + offset)
            .toString(16)
            .padStart(16, "0"),
          ...(stage === "final"
            ? {
                tool_result: {
                  tool_call_id: toolCallId,
                  tool: item.tool,
                  result: structuredClone(item.result),
                },
              }
            : {}),
        });
    }
  return { agents, executions, requests };
}

export function fileCheckpointFixtures() {
  const { agents, requests } = fileStateFixture();
  const item = cases.find((item) => item.id === "read");
  const bytes = Buffer.from(item.result.content);
  const reference = (row) => ({
    phase: row.phase,
    trace_id: row.trace_id,
    model_span_id: row.model_span_id,
    tool_call_id: row.tool_result.tool_call_id,
  });
  return agents.map((agent_id, index) => ({
    protocol_version: index + 1,
    agent_id,
    path: item.path,
    read: {
      ...reference(
        requests.find(
          (row) => row.phase === `v${index + 1}-read` && row.stage === "final",
        ),
      ),
      content: item.result.content,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    failed_edit: reference(
      requests.find(
        (row) =>
          row.phase === `v${index + 1}-failed-edit` && row.stage === "final",
      ),
    ),
  }));
}

export function fileByteReceiptFixtures(runtimes) {
  return fileCheckpointFixtures().map((file, index) => ({
    ...file,
    runtime: structuredClone(runtimes[index]),
    final: {
      file: `file-v${index + 1}-after-failed-edit.private.bin`,
      bytes: file.read.bytes,
      sha256: file.read.sha256,
    },
    claim: "final-bytes-equal-last-complete-read",
  }));
}
