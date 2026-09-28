import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLifecycleModel } from "./model.mjs";

export function decide(payload, skillRestore = false) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[index]?.content;
  assert(
    [
      "c5-before-backup",
      "c5-after-restore",
      "c5-after-restore-peer",
      "c5-after-peer-volume-loss",
      "c5-after-migration-restart",
      "c5-after-migration-v2",
      "c5-after-migration-volume-loss",
      "c5-source-held",
    ].includes(phase),
    "unexpected restore prompt",
  );
  const results = payload.messages
    .slice(index + 1)
    .filter((message) => message.role === "tool");
  assert(results.length <= 1, "backup Tool was replayed");
  if (results.length) {
    if (phase === "c5-source-held")
      assert.match(results[0].content, /source-released/u);
    else if (phase === "c5-before-backup")
      assert(results[0].content.includes("backup-written"));
    else if (skillRestore)
      assert.match(
        JSON.parse(results[0].content).content,
        phase === "c5-after-migration-v2" ||
          phase === "c5-after-migration-volume-loss"
          ? /Stage 4 immutable preset version 2\./
          : /Stage 4 immutable preset version 1\./,
      );
    else
      assert.equal(
        JSON.parse(results[0].content).content,
        "before-backup\n",
        "restored file changed or write replayed",
      );
    return { phase, text: `${phase} completed` };
  }
  const call =
    phase === "c5-source-held"
      ? {
          name: "bash",
          arguments: {
            command:
              "printf started > /workspace/.c5-source-started; while [ ! -f /workspace/.c5-source-release ]; do sleep 0.2; done; printf source-released",
            working_dir: { root: "workspace", path: "." },
            timeout_ms: 120000,
          },
        }
      : phase === "c5-before-backup"
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
              path: skillRestore
                ? { root: "system_skills", path: "code-review/SKILL.md" }
                : { root: "workspace", path: ".c5-restore.txt" },
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
  createLifecycleModel((payload) =>
    decide(payload, process.env.ANTNEST_E2E_SKILL_RESTORE === "true"),
  ).listen(8080, "0.0.0.0");
