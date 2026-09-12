import assert from "node:assert/strict";
import { startModel } from "./model.mjs";

export function decide(payload) {
  const user = payload.messages.findLastIndex((item) => item.role === "user");
  const phase = payload.messages[user]?.content;
  const match = /^v([12])-rpc-(read-)?(acquire|finish)$/.exec(phase);
  assert(match, "unexpected response-loss scenario");
  const marker = `v${match[1]}-rpc-${match[3]}`;
  const read = Boolean(match[2]);
  const results = payload.messages
    .slice(user + 1)
    .filter((item) => item.role === "tool");
  assert(results.length <= 1, "duplicate Tool dispatch");
  if (results.length) {
    const value = JSON.parse(results[0].content);
    if (read)
      assert.equal(value.content, `${marker}\n`, "lost or duplicated effect");
    else {
      assert.equal(value.exit_code, 0, "Bash failed");
      assert.equal(value.stderr, "", "Bash emitted an error");
      assert.equal(value.truncated, false, "Bash output truncated");
      assert.equal(value.effect_state, "settled", "Bash effect not settled");
      assert.equal(value.stdout, `${marker}\n`, "lost or duplicated effect");
    }
    return { phase, text: `${phase} verified` };
  }
  const call = read
    ? {
        name: "read",
        arguments: {
          path: { root: "workspace", path: `${marker}.log` },
          offset: 0,
          limit: 4096,
        },
      }
    : {
        name: "bash",
        arguments: {
          command: `printf '%s\\n' '${marker}' >> /workspace/${marker}.log; cat /workspace/${marker}.log`,
          working_dir: { root: "workspace", path: "." },
          timeout_ms: 10000,
        },
      };
  assert(
    payload.tools.some((tool) => tool.function.name === call.name),
    "Runtime Tool missing",
  );
  return { phase, call };
}
if (process.argv[1]?.endsWith("/rpc-model.mjs")) startModel(decide);
