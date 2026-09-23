import {
  readDevelopmentConfiguration,
  createDevelopmentWriter,
} from "../../support/development-configuration.mjs";
import {
  inspectDevelopmentRuntime,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../../support/verification/development-runtime.mjs";
import { inspectPublication, selectPublications } from "./publication.mjs";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import {
  waitForAgentReady,
  assertAgentDisabled,
  assertAgentDeleted,
} from "../../support/verification/agent-state.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const {
  config,
  settings,
  secrets: privateSettings,
} = readDevelopmentConfiguration(values.config, "lifecycle");
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const secrets = [
  ...Object.entries({ ...settings, ...privateSettings })
    .filter(([k, v]) => /PASSWORD|SECRET|TOKEN|KEY/.test(k) && v?.length > 8)
    .map(([, v]) => v),
];
const admin = new GatewayClient(config.gateway);
const jaeger = config.jaeger;
const retained = config.retainedAgentId;
const report = {
  status: "running",
  checks: [],
  lifecycle: [],
  publication: [],
};
const mutableNames = [
  "lifecycle-progress.json",
  ...["create", "disable", "enable", "rebuild", "delete"].map(
    (kind) => `lifecycle-${kind}.json`,
  ),
];
const write = createDevelopmentWriter(config, mutableNames);
const traceIDs = new Set(),
  requestIDs = new Set();
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 15000 }).trim();
let agentId,
  deleted = false,
  stage = "login";
const read = async (id) => {
  const agent = (await admin.request(`/api/admin/agents/${id}`)).body;
  assert.equal(agent.agent_id, id, "Agent response identity mismatch");
  return agent;
};
function inspectRuntime() {
  return inspectDevelopmentRuntime(
    JSON.parse(docker("inspect", "antnest-runtime-" + agentId)),
    {
      name: "antnest-runtime-" + agentId,
      agentId,
      scope: config.runtimeControllerScope,
      volume: "antnest-workspace-" + agentId,
    },
  );
}
async function completed(id) {
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    const op = (await admin.request(`/api/admin/operations/${id}`)).body;
    assert(["running", "completed"].includes(op.state), "lifecycle failed");
    if (op.state === "completed") return op;
    await delay(300);
  }
  throw new Error("operation completion deadline exceeded");
}
async function record(kind, result, requestId) {
  assert.match(
    result.traceID ?? "",
    /^[a-f0-9]{32}$/u,
    "lifecycle Trace ID missing",
  );
  assert(
    typeof requestId === "string" && /^[a-zA-Z0-9_-]+$/u.test(requestId),
    "operation request ID missing",
  );
  assert(!traceIDs.has(result.traceID), "distinct lifecycle Trace required");
  assert(!requestIDs.has(requestId), "distinct lifecycle request required");
  traceIDs.add(result.traceID);
  requestIDs.add(requestId);
  await completed(requestId);
  const agent = ["create", "enable", "rebuild"].includes(kind)
    ? await waitForAgentReady(() => read(agentId))
    : await read(agentId);
  if (kind === "disable") assertAgentDisabled(agent);
  if (kind === "delete") {
    assertAgentDeleted(agent);
    deleted = true;
  }
  const item = { kind, traceID: result.traceID, agentId, requestId };
  report.lifecycle.push(item);
  write("lifecycle-progress.json", report);
  console.log(
    JSON.stringify({
      stage: kind,
      status: "passed",
      agent_id: agentId,
      trace_id: item.traceID,
    }),
  );
  return agent;
}
async function transition(kind, body = {}) {
  stage = kind;
  const response = await admin.request(`/api/admin/agents/${agentId}/${kind}`, {
    body,
    status: 202,
  });
  return record(kind, response, response.body.request_id);
}
async function publications(organization) {
  const query = new URLSearchParams({
    service: "agent-controller",
    operation: "agent_controller.execution_publication",
    lookback: "15m",
    limit: "100",
    tags: JSON.stringify({ "antnest.organization.id": organization }),
  });
  const response = await fetch(`${jaeger}/api/traces?${query}`, {
    signal: AbortSignal.timeout(10000),
  });
  assert(response.ok, "publication trace search failed");
  const { data } = await response.json();
  assert(data?.length, "publication traces absent");
  for (const found of selectPublications(data)) {
    traceIDs.add(found.traceID);
    const filename = `publication-${found.traceID}.json`;
    mutableNames.push(filename);
    const evidence = await collectTrace(jaeger, found.traceID, (trace) => {
      const result = inspectPublication(
        trace,
        found.traceID,
        organization,
        secrets,
        () => write(filename, trace),
      );
      return result;
    });
    report.publication.push(evidence);
  }
  assert.equal(report.publication.length, 3);
}
try {
  const login = await admin.request("/api/session/login", {
    body: {
      organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
      email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  secrets.push(...admin.cookies.values());
  const original = await read(retained);
  const template = original.configuration.template;
  assert(template?.template_id && template.revision);
  stage = "publication";
  const principal = login.body.principal ?? login.body;
  assert(principal.organization_id, "login organization identity missing");
  await publications(principal.organization_id);
  report.checks.push("three_recording_publications_with_source_http_and_ack");
  stage = "create";
  const created = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      name: config.fixtureName,
      owner_user_id: original.owner_user_id,
      template_id: template.template_id,
      template_revision: template.revision,
    },
  });
  const temporaryId = created.body?.agent?.agent_id;
  assert.match(
    temporaryId ?? "",
    /^agent_[a-f0-9]{32}$/u,
    "temporary Agent ID missing",
  );
  assert.notEqual(
    temporaryId,
    retained,
    "created Agent must not be the retained Agent",
  );
  agentId = temporaryId;
  write("temporary-agent.json", { agent_id: agentId });
  const ready = await record(
    "create",
    created,
    created.body.operation.request_id,
  );
  const name = "antnest-runtime-" + agentId;
  assert.equal(ready.name, config.fixtureName, "temporary Agent name mismatch");
  assert.equal(
    ready.owner_user_id,
    original.owner_user_id,
    "temporary Agent owner mismatch",
  );
  assert.deepEqual(
    ready.configuration.template,
    template,
    "temporary Agent Template mismatch",
  );
  const initial = inspectRuntime();
  const marker = config.workspaceMarker;
  docker(
    "exec",
    initial.Id,
    "sh",
    "-c",
    writeWorkspaceFile,
    "sh",
    config.workspaceFile,
    marker,
  );
  await transition("disable");
  await transition("enable");
  const beforeRebuild = inspectRuntime();
  assert.equal(
    docker(
      "exec",
      beforeRebuild.Id,
      "sh",
      "-c",
      readWorkspaceFile,
      "sh",
      config.workspaceFile,
    ),
    marker,
  );
  const rebuilt = await transition("rebuild", {
    template_id: template.template_id,
    template_revision: template.revision,
  });
  assert.notEqual(
    rebuilt.runtime.runtime_revision,
    ready.runtime.runtime_revision,
  );
  const afterRebuild = inspectRuntime();
  assert.notEqual(beforeRebuild.Id, afterRebuild.Id);
  const workspace = (c) =>
    c.Mounts.find((m) => m.Destination === "/workspace").Name;
  assert.equal(workspace(initial), workspace(afterRebuild));
  assert.equal(
    docker(
      "exec",
      afterRebuild.Id,
      "sh",
      "-c",
      readWorkspaceFile,
      "sh",
      config.workspaceFile,
    ),
    marker,
  );
  report.checks.push(
    "workspace_retained_across_disable_enable_and_physical_rebuild",
  );
  await transition("delete");
  stage = "lifecycle_trace";
  for (const item of report.lifecycle) {
    const evidence = await collectTrace(jaeger, item.traceID, (trace) => {
      const result = inspectLifecycle(trace, item, secrets);
      assert.equal(result.platform_probe_errors, 0);
      write(`lifecycle-${item.kind}.json`, trace);
      return result;
    });
    item.evidence = evidence;
  }
  assert.equal(
    report.lifecycle.reduce(
      (n, l) => n + l.evidence.platform_absence_probes,
      0,
    ),
    4,
  );
  report.checks.push(
    "five_lifecycle_topologies_and_four_expected_absence_probes",
  );
  assert.equal(docker("ps", "-aq", "--filter", "name=^/" + name + "$"), "");
  assert.equal(docker("volume", "ls", "-q", "--filter", "name=" + agentId), "");
  report.checks.push("temporary_runtime_and_workspace_removed");
  const final = await read(retained);
  for (const key of [
    "runtime",
    "configuration",
    "executable_execution_revision",
    "agent_spec_revision",
  ])
    assert.deepEqual(
      final[key],
      original[key],
      "retained Agent changed: " + key,
    );
  report.checks.push("retained_agent_runtime_and_configuration_unchanged");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = {
    stage,
    type: error.name,
    message: String(error.message).split("\n")[0],
  };
  process.exitCode = 1;
} finally {
  if (agentId && !deleted) {
    try {
      await transition("delete");
      report.cleanup = "deleted_after_failure";
    } catch (error) {
      report.cleanup = "requires_review";
      process.exitCode = 1;
    }
  }
  write("lifecycle-report.json", report);
  console.log(JSON.stringify(report));
}
