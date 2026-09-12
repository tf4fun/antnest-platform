import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLifecycleModel } from "./model.mjs";

export function decide(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[index]?.content;
  assert(
    ["c5-before-backup", "c5-after-restore"].includes(phase),
    "unexpected restore prompt",
  );
  const results = payload.messages
    .slice(index + 1)
    .filter((message) => message.role === "tool");
  assert(results.length <= 1, "backup Tool was replayed");
  if (results.length) {
    if (phase === "c5-before-backup")
      assert(results[0].content.includes("backup-written"));
    else
      assert.equal(
        JSON.parse(results[0].content).content,
        "before-backup\n",
        "restored file changed or write replayed",
      );
    return { phase, text: `${phase} completed` };
  }
  const call =
    phase === "c5-before-backup"
      ? {
          name: "bash",
          arguments: {
            command:
              "printf 'before-backup\\n' >> /workspace/.c5-restore.txt; printf backup-written",
            working_dir: { root: "workspace", path: "." },
            timeout_ms: 5000,
          },
        }
      : {
          name: "read",
          arguments: {
            path: { root: "workspace", path: ".c5-restore.txt" },
            offset: 0,
            limit: 4096,
          },
        };
  assert(
    payload.tools.some((tool) => tool.function.name === call.name),
    "required Runtime tool missing",
  );
  return { phase, call };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createLifecycleModel(decide).listen(8080, "0.0.0.0");
