import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createLifecycleModel } from "./model.mjs";

export function decide(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[index]?.content;
  const match = /^c5-(live|cold)-(before|after)$/.exec(phase);
  assert(match, "unexpected loss prompt");
  const [, mode, moment] = match;
  if (moment === "after")
    assert(
      JSON.stringify(payload.messages).includes(
        "isolated execution environment was rebuilt",
      ),
      "environment reset notice missing",
    );
  const results = payload.messages
    .slice(index + 1)
    .filter((message) => message.role === "tool");
  assert(results.length <= 1, "loss Tool was replayed");
  if (results.length) {
    if (moment === "before")
      assert(results[0].content.includes(`${mode}-written`));
    else
      assert.equal(
        JSON.parse(results[0].content).content,
        `${mode}-preserved\n`,
        "workspace lost or append replayed",
      );
    return { phase, text: `${phase} completed` };
  }
  const call =
    moment === "before"
      ? {
          name: "bash",
          arguments: {
            command: `printf '${mode}-preserved\\n' >> /workspace/.c5-loss.txt; printf ${mode}-written`,
            working_dir: { root: "workspace", path: "." },
            timeout_ms: 5000,
          },
        }
      : {
          name: "read",
          arguments: {
            path: { root: "workspace", path: ".c5-loss.txt" },
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
