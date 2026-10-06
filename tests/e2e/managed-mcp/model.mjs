import assert from "node:assert/strict";
import { createServer } from "node:http";

export const guidance = (version) =>
  `Managed workspace guidance version ${version}`;
export const skillSummary = "Managed Skill summary";
export const skillBody = "PRIVATE_SKILL_BODY_NOT_FOR_INITIAL_CONTEXT";

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
    const version = [
      "managed-fresh",
      "managed-rebuilt",
      "managed-draining",
    ].includes(phase)
      ? 2
      : 1;
    assert(
      !system.includes(guidance(version === 2 ? 1 : 2)),
      "stale guidance retained",
    );
    assert(system.includes(guidance(version)), "stale guidance");
    assert(system.includes(skillSummary), "Skill summary missing");
    assert(
      system.includes(".antnest/skills/fixture/SKILL.md"),
      "Skill locator missing",
    );
  }
  const write = (path, content) => ({
    name: "write",
    arguments: { path: path, content },
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
      {
        name: "bash",
        arguments: {
          command:
            phase === "managed-exercise" && results.length >= 2
              ? isolationCommand(results[1].content)
              : "",
          working_dir: ".",
          env: [],
          timeout_ms: 5000,
        },
      },
    ],
    "managed-mutate": [write("AGENTS.md", guidance(2))],
    "managed-fresh": [
      { name: "mcp__alpha__echo", arguments: { value: "managed-fresh" } },
    ],
    "managed-rebuilt": [
      { name: "mcp__beta__echo", arguments: { value: "managed-rebuilt" } },
    ],
    "managed-draining": [
      { name: "mcp__alpha__echo", arguments: { value: "managed-draining" } },
      { name: "mcp__alpha__echo", arguments: { value: "managed-draining" } },
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
  if (phase === "managed-draining") {
    for (const [index, content] of results.entries())
      assertEcho(content.content, phase, 3 + index);
  } else if (phase === "managed-exercise" && results.length >= 2) {
    assertEcho(results[1].content, phase, 1);
    if (results.length === 3)
      assert(
        results[2].content.includes("MANAGED_CREDENTIAL_ISOLATION_OK"),
        "managed credential isolation failed",
      );
  } else if (
    results.length === plan.length &&
    ["managed-fresh", "managed-rebuilt"].includes(phase)
  ) {
    assertEcho(
      results.at(-1).content,
      phase,
      phase === "managed-fresh" ? 2 : 1,
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

function assertEcho(content, phase, calls) {
  const result = JSON.parse(content.slice(content.indexOf("{")));
  assert.equal(result.value, phase);
  assert.equal(result.uid, 2000);
  assert.equal(result.gid, 1000);
  assert.equal(result.explicit_env, true);
  assert.equal(result.supervisor_env, false);
  assert.equal(result.launcher_env, false);
  assert.equal(result.calls, calls, "child process was restarted or replayed");
}

function isolationCommand(content) {
  const { pid } = JSON.parse(content.slice(content.indexOf("{")));
  assert(
    Number.isSafeInteger(pid) && pid > 1,
    "managed process identity missing",
  );
  return `python - <<'PY'
import ctypes, errno, os
pid = ${pid}
assert os.getuid() == 1000 and os.getgid() == 1000
with open('/proc/%d/status' % pid) as status:
    assert any(line.startswith('Uid:') and line.split()[1] == '2000' for line in status)
def denied(action):
    try:
        action()
        return False
    except PermissionError:
        return True
def try_open(path):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    os.close(fd)
for path in ['/proc/%d/environ' % pid, '/proc/%d/mem' % pid, '/run/antnest-mcp/secrets.json']:
    assert denied(lambda: try_open(path))
assert denied(lambda: os.readlink('/proc/%d/fd/0' % pid))
libc = ctypes.CDLL(None, use_errno=True)
assert libc.ptrace(16, pid, None, None) == -1 and ctypes.get_errno() in [errno.EPERM, errno.EACCES]
print('MANAGED_CREDENTIAL_ISOLATION_OK')
PY`;
}

export function createModelFixture({ timeoutMs = 60000 } = {}) {
  const requests = [];
  const errors = [];
  let held = null;
  let release;
  return createServer(async (request, response) => {
    const reply = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && request.url === "/status")
      return reply(200, { requests, errors, held });
    if (request.method === "POST" && /^\/release\/[12]$/.test(request.url)) {
      if (!held || held.step !== Number(request.url.split("/").at(-1)))
        return reply(409, { error: "no_matching_barrier" });
      release();
      return reply(200, { released: true });
    }
    try {
      assert.equal(request.method, "POST");
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
      const lastUser = payload.messages.findLastIndex(
        (message) => message.role === "user",
      );
      const phase = payload.messages[lastUser].content;
      const step = payload.messages
        .slice(lastUser + 1)
        .filter((message) => message.role === "tool").length;
      assert(
        !requests.some((item) => item.phase === phase && item.step === step),
        "duplicate model request",
      );
      requests.push({
        phase,
        step,
        trace_id: request.headers.traceparent.split("-")[1],
        model_span_id: request.headers.traceparent.split("-")[2],
        outcome: "validated",
      });
      if (phase === "managed-draining" && step > 0) {
        assert.equal(held, null, "overlapping model barriers");
        held = { phase, step, received_at: Date.now() };
        let active = true;
        const finish = () => {
          active = false;
          clearTimeout(timer);
          held = null;
          release = undefined;
        };
        const timer = setTimeout(() => {
          finish();
          errors.push("barrier_timeout");
          reply(504, { error: "barrier_timeout" });
        }, timeoutMs);
        release = () => {
          finish();
          reply(200, result);
        };
        response.once("close", () => {
          if (active) {
            finish();
            errors.push("barrier_disconnected");
          }
        });
        return;
      }
      reply(200, result);
    } catch {
      errors.push("invalid_model_request");
      reply(400, { error: "invalid_model_request" });
    }
  });
}
export const startModel = () => createModelFixture().listen(8080, "0.0.0.0");
if (process.argv[1]?.endsWith("/model.mjs")) startModel();
