import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  createBrowserTemplate,
  assertBrowserRuns,
  browserPhases,
} from "./browser-current.mjs";
import { runMigratedBrowser } from "./browser-current-ui.mjs";
import { assertWorkspaceBytes } from "./browser-control.mjs";
import { runtimeBinding } from "./current-evidence.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectBrowserTrace } from "./browser-trace.mjs";
import { assertRuntimeBinding } from "../acp-restart/trace.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import { collectLifecycleEvidence } from "../lifecycle-closeout/foundation-evidence.mjs";
import {
  saveFoundationTrace,
  saveFoundationFailure,
} from "../lifecycle-closeout/foundation-trace.mjs";
import { flushTraceProducers } from "../lifecycle-closeout/network-support.mjs";
import { runtimeStatus } from "../lifecycle-closeout/runtime-status.mjs";

export async function runBrowserProfile({
  config,
  docker,
  signal,
  json,
  agentBody,
  command,
  ready,
  resources,
  traceSecrets,
}) {
  const template = await createBrowserTemplate(json, config.image);
  const created = await command("create", undefined, {
    ...agentBody,
    name: "Browser Agent",
    template_id: template.template_id,
    template_revision: template.revision,
  });
  const agentID = created.agentID,
    initial = await ready(agentID);
  const runtime = runtimeBinding(
    initial,
    await runtimeStatus(docker, config.project, initial.container.Id),
  );
  const persist = (name, value) =>
    writeFile(
      `${config.evidence}/${name}.private.json`,
      JSON.stringify(value),
      { mode: 0o600 },
    );
  const model = async () => {
    const r = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.deepEqual(s.errors, []);
    return s.requests;
  };
  const audits = async () => {
    const page = await json(
      `/api/admin/execution-audits?agent_id=${agentID}&limit=100`,
    );
    assert.equal(page.next_cursor, null);
    const all = [];
    for (const row of page.items) {
      const run = await json(`/api/admin/execution-audits/${row.run_id}`),
        events = await json(
          `/api/admin/execution-audits/${row.run_id}/events?limit=100`,
        );
      assert.equal(events.next_cursor, null);
      all.push({ run, events });
    }
    return { page, all };
  };
  const verifyWorkspace = async () =>
    assertWorkspaceBytes(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        initial.container.Id,
        "base64",
        "-w",
        "0",
        "/workspace/.c4-browser-note",
      ]),
    );
  const browser = await runMigratedBrowser({
    config,
    agentID,
    signal,
    model,
    audits,
    verifyWorkspace,
  });
  const evidence = await audits(),
    runs = assertBrowserRuns(
      evidence.all.map((e) => e.run),
      initial.agent,
    ),
    calls = await model();
  assert.deepEqual(
    calls.map((r) => `${r.phase}:${r.stage}`),
    [
      "c4-browser-write:tool",
      "c4-browser-write:reply",
      "c4-browser-read:tool",
      "c4-browser-read:reply",
      "c4-browser-attachments:reply",
      "c4-browser-mobile:reply",
    ],
  );
  traceSecrets.push("lifecycle-owner-password");
  for (const request of browser.requests.filter(
    (r) => r.method === "session/prompt",
  )) {
    const run = runs[browserPhases.indexOf(request.phase)];
    assert.equal(request.sessionId, run.session_id);
    request.runId = run.run_id;
    request.run = run;
  }
  assert.equal(
    browser.requests.filter((r) => r.method === "session/prompt").length,
    4,
  );
  await persist("requests", browser.requests);
  await persist("model", calls);
  await persist("audits", evidence);
  await persist("runtime", runtime);
  await command("delete", agentID, {});
  assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
  await flushTraceProducers(config, docker);
  const traces = await collectLifecycleEvidence(
    browser.requests,
    (expected) =>
      collectManagedTrace(
        config.jaeger,
        expected,
        traceSecrets,
        expected.phase ? calls.filter((c) => c.phase === expected.phase) : [],
        (trace) => {
          expected.traceID = trace.traceID;
          saveFoundationTrace(config, trace);
        },
        (trace, expected, secrets, modelCalls) => {
          const result = inspectBrowserTrace(
            trace,
            expected,
            secrets,
            modelCalls,
          );
          if (expected.run) {
            assert.equal(result.run_id, expected.runId);
            assertRuntimeBinding(trace, expected.run, runtime);
          }
          return strictSessionEvidence(result, trace);
        },
        signal,
      ),
    (expected, error) =>
      saveFoundationFailure(
        config,
        { traceID: expected.traceID ?? expected.connectionTraceID },
        error,
      ),
    signal,
  );
  return {
    profile: "workspace-browser",
    browser_checks: browser.checks,
    screenshots: browser.screenshots,
    browser_payloads_checked: browser.browser_payloads_checked,
    completed_runs: 4,
    model_requests: 6,
    actual_tool_calls: 2,
    replay_without_effects: true,
    workspace_bytes: "exact",
    deleted_before_teardown: true,
    request_traces: traces,
  };
}
