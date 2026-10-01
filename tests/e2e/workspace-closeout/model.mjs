import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLifecycleModel } from "../lifecycle-closeout/model.mjs";

export function decide(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[index]?.content;
  assert(
    ["c4-cancel", "c4-offline", "c4-rebuilt"].includes(phase),
    "unexpected workspace prompt",
  );
  if (phase === "c4-rebuilt")
    assert(
      JSON.stringify(payload.messages).includes(
        "isolated execution environment was rebuilt",
      ),
      "rebuild context missing",
    );
  const results = payload.messages
    .slice(index + 1)
    .filter((message) => message.role === "tool");
  assert(results.length <= 1, "repeated workspace Tool call");
  if (results.length) {
    if (phase === "c4-rebuilt")
      assert.equal(
        JSON.parse(results[0].content).content,
        "started\nfinished\n",
      );
    else assert(results[0].content.includes(`${phase}-complete`));
    return { phase, text: `${phase} completed` };
  }
  const call =
    phase === "c4-rebuilt"
      ? {
          name: "read",
          arguments: {
            path: ".c4-offline-effects",
            offset: 1,
            limit: 4096,
          },
        }
      : {
          name: "bash",
          arguments: {
            command: `printf 'started\\n' >> /workspace/.${phase}-effects\nprintf '%s' "$$" > /workspace/.${phase}-started\nwhile [ ! -e /workspace/.${phase}-release ]; do sleep 0.1; done\nprintf 'finished\\n' >> /workspace/.${phase}-effects\nprintf '${phase}-complete\\n'`,
            working_dir: ".",
            timeout_ms: 120000,
          },
        };
  assert(payload.tools.some((tool) => tool.function.name === call.name));
  return { phase, call };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createLifecycleModel(decide).listen(8080, "0.0.0.0");
