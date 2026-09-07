import assert from "node:assert/strict";
import { createServer } from "node:http";

export const guidance = (version) =>
  `Managed workspace guidance version ${version}`;
export const skillSummary = "Managed Skill summary";
export const skillBody = "PRIVATE_SKILL_BODY_NOT_FOR_INITIAL_CONTEXT";
const requests = [];

export function complete(payload) {
  const lastUser = payload.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const phase = payload.messages[lastUser]?.content;
  const results = payload.messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "tool");
  const system = payload.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const server = phase === "managed-rebuilt" ? "beta" : "alpha";
  const names = payload.tools.map((tool) => tool.function.name);
  assert(names.includes(`mcp__${server}__echo`), "managed tool missing");
  assert(
    !names.includes(`mcp__${server === "alpha" ? "beta" : "alpha"}__echo`),
    "stale tool catalog",
  );
  assert.equal(
    system.split("Current Runtime information").length - 1,
    1,
    "Runtime information block must be unique",
  );
  assert(
    !system.includes(skillBody),
    "full Skill body leaked into initialization",
  );
  assert(
    !JSON.stringify(payload).includes("managed-env-canary"),
    "process environment leaked to model",
  );
  if (phase !== "managed-bootstrap") {
    const version = ["managed-fresh", "managed-rebuilt"].includes(phase)
      ? 2
      : 1;
    assert(
      !system.includes(guidance(version === 2 ? 1 : 2)),
      "stale guidance retained",
    );
    assert(
      system.includes(
        guidance(["managed-fresh", "managed-rebuilt"].includes(phase) ? 2 : 1),
      ),
      "stale guidance",
    );
    assert(system.includes(skillSummary), "Skill summary missing");
    assert(
      system.includes(".antnest/skills/fixture/SKILL.md"),
      "Skill locator missing",
    );
  }
  const write = (path, content) => ({
    name: "write",
    arguments: { path: { root: "workspace", path }, content },
  });
  const plans = {
    "managed-bootstrap": [
      write("AGENTS.md", guidance(1)),
      write(
        ".antnest/skills/fixture/SKILL.md",
        `---\nname: Fixture\ndescription: ${skillSummary}\n---\n${skillBody}\n`,
      ),
    ],
    "managed-exercise": [
      { name: "mcp__alpha__fail", arguments: {} },
      { name: "mcp__alpha__echo", arguments: { value: "managed-exercise" } },
    ],
    "managed-mutate": [write("AGENTS.md", guidance(2))],
    "managed-fresh": [
      { name: "mcp__alpha__echo", arguments: { value: "managed-fresh" } },
    ],
    "managed-rebuilt": [
      { name: "mcp__beta__echo", arguments: { value: "managed-rebuilt" } },
    ],
  };
  const plan = plans[phase];
  assert(plan, "unknown fixture phase");
  assert(results.length <= plan.length, "replayed tool side effect");
  if (phase === "managed-exercise" && results.length > 0)
    assert(
      results[0].content.includes("fixture tool failed"),
      "ordinary tool error was lost",
    );
  if (
    results.length === plan.length &&
    ["managed-exercise", "managed-fresh", "managed-rebuilt"].includes(phase)
  ) {
    const content = results.at(-1).content;
    const result = JSON.parse(content.slice(content.indexOf("{")));
    assert.equal(result.value, phase);
    assert.equal(result.uid, 1000);
    assert.equal(result.gid, 1000);
    assert.equal(result.explicit_env, true);
    assert.equal(result.supervisor_env, false);
    assert.equal(result.launcher_env, false);
    assert.equal(
      result.calls,
      phase === "managed-fresh" ? 2 : 1,
      "child process was restarted or replayed",
    );
  }
  const call = plan[results.length];
  return {
    choices: [
      {
        finish_reason: call ? "tool_calls" : "stop",
        message: call
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `${phase}-${results.length}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                },
              ],
            }
          : { role: "assistant", content: `${phase} verified` },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
}

export function startModel() {
  return createServer(async (request, response) => {
    const reply = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests });
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer managed-model-test");
      assert.match(
        request.headers.traceparent ?? "",
        /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024, "fixture body too large");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      const result = complete(payload);
      requests.push({
        phase: payload.messages.findLast((message) => message.role === "user")
          .content,
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
        outcome: "validated",
      });
      reply(200, result);
    } catch (error) {
      console.error(error);
      reply(400, { error: error.message });
    }
  }).listen(8080, "0.0.0.0");
}
if (process.argv[1]?.endsWith("/model.mjs")) startModel();
