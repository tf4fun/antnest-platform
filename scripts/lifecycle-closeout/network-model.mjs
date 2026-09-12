import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLifecycleModel } from "./model.mjs";
import { probeCommand } from "./network-evidence.mjs";

export function decideNetwork(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex((m) => m.role === "user");
  const input = JSON.parse(payload.messages[index]?.content);
  const command = probeCommand(input);
  const results = payload.messages
    .slice(index + 1)
    .filter((m) => m.role === "tool");
  assert(results.length <= 1, "network tool repeated");
  if (results.length) {
    const result = JSON.parse(results[0].content);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stderr, "");
    return {
      phase: input.phase,
      report: JSON.parse(result.stdout),
      text: `${input.phase} checked`,
    };
  }
  assert(payload.tools.some((t) => t.function.name === "bash"));
  return {
    phase: input.phase,
    call: {
      name: "bash",
      arguments: {
        command,
        working_dir: { root: "workspace", path: "." },
        timeout_ms: 55000,
      },
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  createLifecycleModel(decideNetwork).listen(8080, "0.0.0.0");
