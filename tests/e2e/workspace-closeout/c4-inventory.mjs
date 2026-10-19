import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { note, imageData } from "./browser-model.mjs";
import { audioData } from "../acp-multimodal/fixtures.mjs";
import { runtimeBinding } from "./current-evidence.mjs";

const plans = [
  ["write", ["tool", "reply"], "bash"],
  ["read", ["tool", "reply"], "read"],
  ["attachments", ["reply"]],
  ["unsupported-audio", []],
  ["approve", ["tool", "reply"], "read"],
  ["hold-cancel", ["reply"]],
  ["after-cancel", ["reply"]],
  ["hold-offline", ["reply"]],
  ["hold-close", ["reply"]],
  ["after-rebuild", ["tool", "reply"], "read"],
  ["mobile", ["reply"]],
].map(([suffix, stages, toolName], index) => ({
  suffix,
  phase: `c4-browser-${suffix}`,
  stages,
  toolName,
  runtime: index < 9 ? "initial" : "rebuilt",
}));

const list = (value) => (Array.isArray(value) ? value : []);
const nonempty = (value) =>
  assert(typeof value === "string" && value.trim().length > 0);
const unique = (values) => {
  values.forEach(nonempty);
  assert.equal(new Set(values).size, values.length, "duplicate C4 identity");
};

// Keep independently observed page and Provider traces collectable even when
// business execution or an audit refresh failed. Completeness is checked only
// after every available trace has had its own collection/archive attempt.
export function c4PromptExpectations(report) {
  const execution = list(report.execution?.model?.requests),
    browser = list(report.model?.requests),
    requests = [],
    receipts = list(report.prompt_receipts),
    audits = list(report.execution?.audits?.all),
    bindings = list(report.runtime_bindings);
  for (const request of [...execution, ...browser])
    if (!requests.some((prior) => isDeepStrictEqual(prior, request)))
      requests.push(request);
  const build = (traceID, phase, receipt) => {
    const plan = plans.find((row) => row.phase === phase),
      run = audits.find((row) => row.run?.input?.[0]?.text === phase)?.run,
      runtime = bindings.find((row) => row.name === plan?.runtime)?.binding;
    return {
      kind: "c4_run",
      traceID,
      phase,
      agentId: report.agent_id,
      sessionId: receipt?.sessionId ?? report.sessions?.[phase],
      bridge: true,
      receipt,
      run,
      runId: run?.run_id,
      runtime,
      modelName: "stage3-model",
      ...(plan?.toolName ? { toolName: plan.toolName } : {}),
      requests: requests.filter((row) => row.trace_id === traceID),
      provider_observations: {
        execution: execution.filter((row) => row.trace_id === traceID),
        browser: browser.filter((row) => row.trace_id === traceID),
      },
    };
  };
  const rows = receipts
    .filter(
      (receipt) => typeof receipt?.traceID === "string" && receipt.traceID,
    )
    .map((receipt) => build(receipt.traceID, receipt.phase, receipt));
  for (const request of requests)
    if (
      request.trace_id &&
      !rows.some((row) => row.traceID === request.trace_id)
    )
      rows.push(build(request.trace_id, request.phase));
  return rows;
}

function originalInput({ suffix, phase }) {
  const prompt = [{ type: "text", text: phase }];
  if (suffix === "attachments")
    prompt.push(
      {
        type: "resource",
        resource: {
          uri: "attachment:///workspace-notes.md",
          mimeType: "text/markdown",
          text: note,
        },
      },
      { type: "image", mimeType: "image/png", data: imageData },
    );
  if (suffix === "unsupported-audio")
    prompt.push({ type: "audio", mimeType: "audio/wav", data: audioData });
  return prompt;
}

function physicalBindings(report, owner) {
  const entries = report.runtime_bindings;
  assert.equal(
    entries?.length,
    2,
    "both observed C4 Runtime bindings required",
  );
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["initial", "rebuilt"],
  );
  nonempty(report.runtime_image_id);
  for (const entry of entries) {
    const { observed, status, binding } = entry;
    assert.deepEqual(binding, runtimeBinding(observed, status));
    assert.equal(observed.agent.agent_id, report.agent_id);
    assert.equal(observed.agent.owner_user_id, owner);
    nonempty(observed.agent.executable_execution_revision);
    assert.equal(observed.container.Image, report.runtime_image_id);
    assert.equal(observed.container.State.Running, true);
    assert.equal(observed.container.State.Health?.Status, "healthy");
    nonempty(observed.volume);
  }
  for (const select of [
    (row) => row.observed.container.Id,
    (row) => row.observed.agent.executable_execution_revision,
    (row) => row.binding.runtime_revision,
    (row) => row.binding.runtime_execution_id,
  ])
    unique(entries.map(select));
  assert.equal(entries[1].status.generation, entries[0].status.generation + 1);
  assert.equal(entries[1].observed.volume, entries[0].observed.volume);
  return entries;
}

export function assertC4ExecutionInventory(report) {
  nonempty(report.agent_id);
  const owner = report.page_login?.issued?.principal?.user_id;
  nonempty(owner);
  const bindings = physicalBindings(report, owner),
    { audits, model } = report.execution ?? {};
  assert.equal(
    audits?.page?.next_cursor,
    null,
    "complete C4 audit page required",
  );
  assert.equal(audits.page.items?.length, 11);
  assert.equal(audits.all?.length, 11);
  unique(audits.page.items.map((row) => row.run_id));
  unique(audits.all.map((row) => row.run.run_id));
  assert.deepEqual(
    audits.page.items.map((row) => row.run_id).sort(),
    audits.all.map((row) => row.run.run_id).sort(),
  );
  assert.deepEqual(model?.pending, []);
  assert.deepEqual(model?.errors, []);
  assert.equal(model.requests?.length, 14);
  assert.deepEqual(report.model, model, "C4 model snapshots disagree");
  unique(model.requests.map((row) => row.model_span_id));
  for (const request of model.requests)
    assert.match(request.model_span_id, /^(?!0{16}$)[a-f0-9]{16}$/u);
  assert.equal(report.prompt_receipts?.length, 11);
  unique(report.prompt_receipts.map((row) => row.traceID));
  unique(report.prompt_receipts.map((row) => row.request?.body?.intentId));
  const rows = c4PromptExpectations(report);
  assert.equal(rows.length, 11);
  const ordered = plans.map((plan) => {
    const matching = rows.filter((row) => row.phase === plan.phase);
    assert.equal(
      matching.length,
      1,
      "one original page Prompt per C4 phase required",
    );
    const row = matching[0],
      receipt = row.receipt,
      matches = audits.all.filter(
        (audit) => audit.run.input?.[0]?.text === plan.phase,
      );
    assert.equal(matches.length, 1, "one durable Run per C4 phase required");
    const { run, events } = matches[0],
      summary = audits.page.items.find((entry) => entry.run_id === run.run_id),
      binding = bindings.find((entry) => entry.name === plan.runtime),
      input = originalInput(plan);
    assert(receipt, "original C4 page Prompt receipt required");
    assert.match(receipt.traceID, /^(?!0{32}$)[a-f0-9]{32}$/u);
    assert.equal(receipt.original_browser_authority, true);
    assert.equal(receipt.method, "POST");
    assert.equal(receipt.status, 202);
    assert.equal(receipt.agentId, report.agent_id);
    nonempty(receipt.sessionId);
    assert.equal(receipt.sessionId, report.sessions?.[plan.phase]);
    assert.equal(
      receipt.path,
      `/api/app/workspace/v1/agents/${encodeURIComponent(report.agent_id)}/sessions/${encodeURIComponent(receipt.sessionId)}/prompts`,
    );
    nonempty(receipt.request.historyToken);
    assert.deepEqual(JSON.parse(receipt.request.rawBody), receipt.request.body);
    assert.deepEqual(receipt.request.body.prompt, input);
    assert(
      Number.isSafeInteger(receipt.request.body.expectedAppendVersion) &&
        receipt.request.body.expectedAppendVersion >= 0,
    );
    assert.deepEqual(JSON.parse(receipt.rawBody), receipt.body);
    assert.deepEqual(receipt.body, {
      operationId: receipt.request.body.intentId,
      acceptance: "bridge",
      phase: "dispatching",
    });
    assert.equal(run.agent_id, report.agent_id);
    assert.equal(run.principal_id, owner);
    assert.equal(run.session_id, receipt.sessionId);
    assert.deepEqual(run.input, input);
    for (const key of ["agent_id", "principal_id", "session_id", "state"])
      assert.equal(summary[key], run[key]);
    const state =
      plan.suffix === "hold-cancel"
        ? "cancelled"
        : plan.suffix === "unsupported-audio"
          ? "failed"
          : "completed";
    assert.equal(run.state, state);
    assert.equal(run.terminal_class, state);
    assert.equal(run.executor_state, "quiescent");
    assert.equal(run.tool_effect_state, plan.toolName ? "settled" : "none");
    assert.equal(run.stop_reason, state === "completed" ? "end_turn" : null);
    assert.equal(
      run.error_class,
      state === "failed" ? "model_unsupported_content" : null,
    );
    assert.equal(
      run.execution_snapshot?.executionRevision,
      binding.observed.agent.executable_execution_revision,
    );
    assert.equal(events.stream, "execution");
    assert.equal(events.next_cursor, null);
    assert(Array.isArray(events.items));
    assert.deepEqual(
      row.requests.map((request) => request.stage),
      plan.stages,
    );
    for (const request of row.requests) {
      assert.equal(request.phase, plan.phase);
      assert.equal(request.trace_id, row.traceID);
      assert.equal(
        request.disconnected === true,
        plan.suffix === "hold-cancel",
      );
    }
    if (plan.suffix === "hold-cancel")
      for (const [key, value] of Object.entries({
        runId: run.run_id,
        sessionId: run.session_id,
        agentId: run.agent_id,
      }))
        assert.equal(report.cancelled_run?.[key], value);
    return row;
  });
  assert.equal(
    ordered.reduce((count, row) => count + row.requests.length, 0),
    14,
  );
  const original = ordered[0].sessionId;
  for (const [index, plan] of plans.entries())
    if (!["unsupported-audio", "after-cancel", "mobile"].includes(plan.suffix))
      assert.equal(ordered[index].sessionId, original);
  unique([
    original,
    ...ordered
      .filter((row) =>
        [
          "c4-browser-unsupported-audio",
          "c4-browser-after-cancel",
          "c4-browser-mobile",
        ].includes(row.phase),
      )
      .map((row) => row.sessionId),
  ]);
  return ordered;
}
