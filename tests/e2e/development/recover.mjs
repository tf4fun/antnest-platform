import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  readDevelopmentConfiguration,
  createDevelopmentWriter,
} from "../../support/development-configuration.mjs";
import { workspaceManifestCommand } from "../../support/verification/workspace-manifest.mjs";
import { inspectDevelopmentRuntime } from "../../support/verification/development-runtime.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("--config is required");
const {
  config,
  settings,
  secrets: privateSettings,
  workspaceManifest,
} = readDevelopmentConfiguration(values.config, "recover");
process.umask(0o077);
mkdirSync(config.output, { recursive: true, mode: 0o700 });
const secrets = Object.entries({ ...settings, ...privateSettings })
  .filter(
    ([key, value]) =>
      /PASSWORD|SECRET|TOKEN|KEY/.test(key) && value?.length > 8,
  )
  .map(([, value]) => value);
const admin = new GatewayClient(config.gateway);
const agentId = config.retainedAgentId;
const name = config.runtimeContainerPrefix + agentId;
const report = {
  status: "running",
  checks: [],
  lifecycle: [],
  publication: [],
};
const write = createDevelopmentWriter(config, ["recovery-trace.private.json"]);
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 15000 }).trim();
let stage = "login";
const read = async () => {
  const agent = (await admin.request(`/api/admin/agents/${agentId}`)).body;
  assert.equal(agent.agent_id, agentId, "Agent response identity mismatch");
  return agent;
};
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
function inspectRuntime() {
  const rows = JSON.parse(docker("inspect", name));
  return inspectDevelopmentRuntime(rows, {
    name,
    agentId,
    scope: config.runtimeControllerScope,
    volume: config.workspaceVolume,
  });
}
try {
  await admin.request("/api/session/login", {
    body: {
      organization_slug: settings.ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG,
      email: settings.ANTNEST_BOOTSTRAP_ADMIN_EMAIL,
      password: settings.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD,
    },
  });
  secrets.push(...admin.cookies.values());
  stage = "source";
  const original = await read();
  assert.equal(original.failure_code, "runtime_execution_changed");
  const template = original.configuration?.template;
  assert(
    typeof template?.template_id === "string" && template.template_id,
    "Template identity missing",
  );
  assert(
    Number.isSafeInteger(template.revision) && template.revision > 0,
    "Template revision missing",
  );
  const before = inspectRuntime();
  stage = "rebuild";
  const response = await admin.request(`/api/admin/agents/${agentId}/rebuild`, {
    body: {
      template_id: template.template_id,
      template_revision: template.revision,
    },
    status: 202,
  });
  const requestId = response.body?.request_id;
  assert(
    typeof requestId === "string" && requestId,
    "operation request ID missing",
  );
  assert.match(
    response.traceID ?? "",
    /^[a-f0-9]{32}$/u,
    "rebuild Trace ID missing",
  );
  await completed(requestId);
  const recovered = await waitForAgentReady(read);
  const item = {
    kind: "rebuild",
    traceID: response.traceID,
    agentId,
    requestId,
  };
  report.lifecycle.push(item);
  write("lifecycle-progress.json", report);
  console.log(
    JSON.stringify({
      stage: "rebuild",
      status: "passed",
      agent_id: agentId,
      trace_id: item.traceID,
    }),
  );
  const after = inspectRuntime();
  assert.notEqual(after.Id, before.Id);
  assert.equal(after.State?.Running, true, "recovered Runtime is not running");
  const volume = (row) =>
    row.Mounts.find((m) => m.Destination === "/workspace").Name;
  assert.equal(volume(after), volume(before));
  assert.equal(
    docker("exec", after.Id, "sh", "-c", workspaceManifestCommand) + "\n",
    workspaceManifest,
  );
  assert.deepEqual(recovered.configuration, original.configuration);
  const state = (await admin.request(`/api/app/agents/${agentId}/state`)).body;
  assert.equal(state.agent_id, agentId, "execution state Agent mismatch");
  assert.equal(state.availability, "ready");
  assert.equal(state.active_session_id, null);
  write("recovered-runtime.json", {
    before_id: before.Id,
    after_id: after.Id,
    workspace: volume(after),
    configuration_preserved: true,
    workspace_bytes_preserved: true,
  });
  item.evidence = await collectTrace(config.jaeger, item.traceID, (trace) => {
    write("recovery-trace.private.json", trace);
    return inspectLifecycle(trace, item, secrets);
  });
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
  write("recovery-report.json", report);
  console.log(JSON.stringify(report));
}
