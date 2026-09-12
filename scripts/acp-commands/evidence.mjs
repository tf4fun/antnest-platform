import assert from "node:assert/strict";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";

export function assertOrdinaryTool(frames, version, phase) {
  const updates = frames.map(({ update }) => update);
  const tools = updates.filter((update) =>
    ["tool_call", "tool_call_update"].includes(update.sessionUpdate),
  );
  assert(tools.length >= 2, "missing Tool lifecycle");
  assert.equal(
    tools[0].sessionUpdate,
    version === 1 ? "tool_call" : "tool_call_update",
  );
  assert(tools[0].toolCallId, "missing Tool ID");
  assert.equal(
    new Set(tools.map((tool) => tool.toolCallId)).size,
    1,
    "unexpected Tool identity",
  );
  assert(
    tools.slice(1).every((tool) => tool.sessionUpdate === "tool_call_update"),
  );
  assert(
    tools.slice(0, -1).every((tool) => tool.status === "in_progress"),
    "repeated or misplaced Tool terminal",
  );
  const terminal = tools.at(-1);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.content?.length, 1, "missing or ambiguous Tool result");
  const block = terminal.content[0];
  assert(
    block.type === "content" && block.content?.type === "text",
    "Bash result must be text JSON",
  );
  let result;
  try {
    result = JSON.parse(block.content.text);
  } catch {
    throw new Error("Bash result is not structured JSON");
  }
  assert(
    result?.exit_code === 0 &&
      result.stderr === "" &&
      result.truncated === false &&
      result.effect_state === "settled",
    "Bash result was not successful, complete and settled",
  );
  assert(
    typeof result.stdout === "string" && result.stdout.includes(phase),
    "missing actual stdout effect",
  );
  const reply = updates.findIndex((update) =>
    ["agent_message", "agent_message_chunk"].includes(update.sessionUpdate),
  );
  assert(
    reply > updates.indexOf(terminal),
    "Tool result did not precede final response",
  );
}

export function assertCatalog(frames, sessionId) {
  assert(
    frames.every((frame) => frame.sessionId === sessionId),
    "foreign Session notification",
  );
  const catalogs = frames.filter(
    ({ update }) => update.sessionUpdate === "available_commands_update",
  );
  assert.equal(catalogs.length, 1, "missing or duplicated command catalog");
  const commands = catalogs[0].update.availableCommands;
  assert.deepEqual(
    commands.map(({ name }) => name),
    ["help"],
  );
  assert(commands[0].description.includes("/帮助"), "missing localized alias");
}

export function transcript(frames, sessionId) {
  const messages = [];
  for (const { sessionId: actual, update } of frames) {
    assert.equal(actual, sessionId, "foreign Session history");
    const kind = update.sessionUpdate;
    if (
      ![
        "user_message",
        "user_message_chunk",
        "agent_message",
        "agent_message_chunk",
      ].includes(kind)
    )
      continue;
    const role = kind.startsWith("user") ? "user" : "assistant";
    const content = Array.isArray(update.content)
      ? update.content
      : [update.content];
    const previous = messages.at(-1);
    if (
      kind.endsWith("_chunk") &&
      update.messageId &&
      previous?.id === update.messageId &&
      previous.role === role
    ) {
      previous.content.push(...content);
    } else {
      messages.push({ id: update.messageId, role, content: [...content] });
    }
  }
  return messages.map(({ role, content }) => ({ role, content }));
}

export function assertTranscript(frames, sessionId, expected) {
  assert.deepEqual(
    transcript(frames, sessionId),
    expected,
    "changed, missing or duplicated transcript",
  );
}

export function inspectCommandTrace(trace, expected, secrets = []) {
  assert(trace?.spans?.length, "trace not exported");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  assert.equal(spans.size, trace.spans.length, "duplicate span IDs");
  const service = (span) => {
    const name = trace.processes[span.processID]?.serviceName;
    assert(name, "unknown span process");
    return name;
  };
  const ancestors = (span) => {
    const result = [];
    const seen = new Set();
    while (span) {
      assert(!seen.has(span.spanID), "cyclic trace ancestry");
      seen.add(span.spanID);
      result.push(span);
      const parent = span.references?.find((ref) => ref.refType === "CHILD_OF");
      span =
        parent?.traceID === trace.traceID
          ? spans.get(parent.spanID)
          : undefined;
    }
    return result;
  };
  const within = (span, parent) =>
    ancestors(span).some((candidate) => candidate.spanID === parent.spanID);
  const named = (name) =>
    trace.spans.filter(
      (span) =>
        service(span) === "agent-acp-service" && span.operationName === name,
    );
  const tag = (span, key) => span.tags?.find((item) => item.key === key)?.value;
  for (const span of trace.spans) {
    const owner = service(span);
    assert.notEqual(owner, "antnest-runtime", "command reached Runtime");
    assert(
      !/^(model\.|mcp\.|agent_controller\.resolve_credential$)/.test(
        span.operationName,
      ),
      "command executed model, MCP or credential resolution",
    );
    if (["agent-acp-service", "agent-controller"].includes(owner)) {
      assert(
        ancestors(span).some((parent) => service(parent) === "edge-gateway"),
        `missing Gateway ancestry: ${span.operationName}`,
      );
    }
  }
  for (const method of expected.methods)
    assert(named(method).length > 0, `missing ${method}`);
  const runs = named("agent.run");
  assert.equal(runs.length, expected.runs, "unexpected command Run count");
  assert.equal(
    named("agent_controller.acquire_run").length,
    expected.runs,
    "missing admission",
  );
  const finishes = named("agent_controller.finish_run");
  assert.equal(finishes.length, expected.runs, "missing admission closure");
  const runIDs = new Set(),
    admissions = new Set();
  for (const run of runs) {
    const id = tag(run, "run.id"),
      admission = tag(run, "admission.id");
    assert(
      id && admission && !runIDs.has(id) && !admissions.has(admission),
      "missing or reused Run identity",
    );
    runIDs.add(id);
    admissions.add(admission);
    assert(
      named("postgres.transaction").some((span) => within(span, run)),
      "missing durable command transaction",
    );
    const closure = finishes.filter(
      (span) => within(span, run) && tag(span, "admission.id") === admission,
    );
    assert.equal(closure.length, 1, "missing Run-specific closure");
    assert(
      trace.spans.some(
        (span) =>
          service(span) === "agent-controller" && within(span, closure[0]),
      ),
      "missing Controller closure RPC",
    );
  }
  assertSecretFree(JSON.stringify(trace), secrets);
  return {
    trace_id: trace.traceID,
    spans: trace.spans.length,
    runs: runs.length,
    no_model_or_runtime: true,
    gateway_ancestry: true,
  };
}
