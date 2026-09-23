import { durablePath } from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
  scopeLabel,
  lines,
} from "../lifecycle-closeout/docker.mjs";
import { setup } from "./c4-setup.mjs";
import { runBrowser } from "./c4-browser.mjs";
import { assertWorkspaceBytes } from "./browser-control.mjs";
import { inspectChatTrace, inspectChatTraceTopology } from "./chat-trace.mjs";
import {
  assertCaptureDisabled,
  traceTopology,
} from "../observability/trace-tree.mjs";

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("C4 acceptance interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 1200000);
const output = `artifacts/verification/c4-browser-${new Date().toISOString().replace(/[:.]/g, "-")}`;
durablePath(output);
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  checks: [],
  sessions: {},
  traces: [],
  cleanup: "pending",
};
const checkpoint = () =>
  writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
let config;
try {
  config = await configuration(abort.signal);
  config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT = "false";
  config.env.ANTNEST_C4_CONTROL_DYNAMIC_RANGE =
    config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25");
  config.env.ANTNEST_C4_RUNTIME_DYNAMIC_RANGE =
    config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(".0/24", ".128/25");
  report.project = config.project;
  report.runtime_image = config.image;
  console.error(
    `C4 disposable project: ${config.project}; evidence: ${output}`,
  );
  await checkpoint();
  const docker = dockerClient(config.env, abort.signal, 1200000);
  report.agent_ui_image = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    config.env.ANTNEST_C4_AGENT_UI_IMAGE ?? "antnest/agent-ui:local",
  ]);
  try {
    await docker(
      composeArgs(config.project, [
        "-f",
        "tests/e2e/workspace-closeout/c4.compose.yaml",
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
      ]),
      true,
    );
  } catch (error) {
    const ids = lines(
      await docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${config.project}`,
      ]),
    );
    const containers = ids.length
      ? JSON.parse(await docker(["inspect", ...ids]))
      : [];
    report.startup = containers.map((c) => ({
      service: c.Config.Labels["com.docker.compose.service"],
      state: c.State.Status,
      error: c.State.Error,
      health: c.State.Health,
    }));
    console.error(JSON.stringify(report.startup));
    throw error;
  }
  console.error("C4 stack healthy; creating current-contract fixture");
  const fixture = await setup(config, abort.signal);
  report.agent_id = fixture.agentID;
  fixture.verifyWorkspace = async () => {
    const ids = lines(
      await docker([
        "ps",
        "-q",
        "--filter",
        `label=${scopeLabel}=${config.project}`,
        "--filter",
        `label=io.antnest.agent-id=${fixture.agentID}`,
      ]),
    );
    assert.equal(ids.length, 1);
    assertWorkspaceBytes(
      await docker([
        "exec",
        "--user",
        "1000:1000",
        ids[0],
        "base64",
        "-w",
        "0",
        "/workspace/.c4-browser-note",
      ]),
    );
    report.workspace_bytes = "exact, single write retained across rebuild";
  };
  await runBrowser(config, fixture, abort.signal, output, report, checkpoint);
  await delay(6000, undefined, { signal: abort.signal });
  for (const id of new Set(
    report.model.requests.map((request) => request.trace_id),
  )) {
    const requests = report.model.requests.filter(
      (request) => request.trace_id === id,
    );
    const response = await fetch(`${config.jaeger}/api/traces/${id}`, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.errors?.length ?? 0, 0);
    assert.equal(body.data?.length, 1);
    const trace = body.data[0];
    assert.equal(trace.traceID, id);
    assertCaptureDisabled(trace);
    assert(!JSON.stringify(trace).includes("stage3-model-secret"));
    await writeFile(`${output}/trace-${id}.json`, JSON.stringify(trace));
    if (requests.some((request) => request.disconnected)) {
      traceTopology(trace);
      report.traces.push({
        phase: requests[0].phase,
        trace_id: id,
        expected_cancellation: true,
      });
      continue;
    }
    const expected = {
      sessionId: report.sessions[requests[0].phase],
      requireTools: requests.some((request) => request.stage === "tool"),
      secrets: ["stage3-model-secret", "c4-member-password"],
    };
    const checked = inspectChatTraceTopology(trace, expected);
    let strict = "passed";
    try {
      inspectChatTrace(trace, expected);
    } catch {
      strict = "failed";
    }
    report.traces.push({ phase: requests[0].phase, ...checked, strict });
  }
  report.status = "browser_passed";
  report.strict_trace = report.traces.some((trace) => trace.strict === "failed")
    ? "failed"
    : "passed";
  if (report.strict_trace === "failed") process.exitCode = 1;
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  clearTimeout(timer);
  try {
    if (config) await cleanup(config);
    report.cleanup = "verified";
  } catch (error) {
    report.cleanup = "failed";
    process.exitCode = 1;
    console.error(error.message);
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await checkpoint();
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      strict_trace: report.strict_trace,
      cleanup: report.cleanup,
      evidence: output,
    }),
  );
}
