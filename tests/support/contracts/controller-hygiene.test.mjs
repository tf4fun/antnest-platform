import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brokenMarkdownLinks } from "../check-markdown-links.mjs";
import { loadGolden, validateGolden } from "./golden.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const repoDir = fileURLToPath(repoRoot);
const contractsRoot = new URL("contracts/", repoRoot);
const controllerRoot = new URL("agent-controller/", contractsRoot);

const repoPath = (relative) => fileURLToPath(new URL(relative, repoRoot));
const repoText = (relative) => readFileSync(repoPath(relative), "utf8");
const contractJson = (relative) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, contractsRoot)), "utf8"),
  );

const control = contractJson("agent-controller/control-contract.json");
const schema = contractJson("agent-controller/control-api.ids-v2.schema.json");
const readinessFixtures = contractJson(
  "agent-controller/readiness-fixtures.json",
);
const controlApi = repoText("contracts/agent-controller/control-api.md");

const CONTROL_SCHEMA = "agent-controller/control-api.ids-v2.schema.json";
const STATUS_REF = "control-api.ids-v2.schema.json#/$defs/status";

const valid = async (ref, document) =>
  assert.equal(await validateGolden(ref, document), true);
const invalid = async (ref, document) =>
  assert.rejects(() => validateGolden(ref, document));

const pointerSegment = (segment) =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

function resolveControllerRef(ref) {
  const hash = ref.indexOf("#");
  const file = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  let node = JSON.parse(
    readFileSync(fileURLToPath(new URL(file, controllerRoot)), "utf8"),
  );
  if (pointer !== "") {
    assert.ok(pointer.startsWith("/"), `unsupported ref ${ref}`);
    for (const segment of pointer.slice(1).split("/").map(pointerSegment)) {
      assert.ok(
        node !== null && typeof node === "object" && segment in node,
        `unresolvable ref ${ref}`,
      );
      node = node[segment];
    }
  }
  return node;
}

test("revision 51 retains the authorization RPC on the global error response", () => {
  assert.equal(control.contract, "antnest.agent-controller.lifecycle");
  assert.equal(control.revision, 51);
  const set = control.resources.agent_authorization?.set;
  assert.equal(set?.method, "POST");
  assert.equal(set?.path, "/rpc/agent-controller/set-agent-authorization");
  assert.equal(
    set?.request,
    "control-api.ids-v2.schema.json#/$defs/set_agent_authorization_request",
  );
  assert.equal(
    set?.response,
    "control-api.ids-v2.schema.json#/$defs/set_agent_authorization_response",
  );
  assert.equal(
    control.errors.response,
    "control-api.ids-v2.schema.json#/$defs/error",
  );
  assert.match(
    controlApi,
    /issues\/582/,
    "control-api.md omits the owner-settings followup link",
  );
});

test("policy routes resolve message refs and share the global error response", () => {
  for (const name of [
    "skill_learning_policy",
    "runtime_barrier_recovery_policy",
    "model_call_policy",
    "agent_network_policy",
  ]) {
    const resource = control.resources[name];
    assert.ok(resource, `${name} missing from the catalog`);
    for (const [operationName, operation] of Object.entries(resource))
      for (const key of ["request", "response"])
        if (key in operation)
          assert.ok(
            resolveControllerRef(operation[key]),
            `${name}.${operationName}.${key}`,
          );
  }
  assert.equal(
    control.errors.response,
    "control-api.ids-v2.schema.json#/$defs/error",
  );
  assert.deepEqual(
    resolveControllerRef(control.errors.response),
    schema.$defs.error,
  );
});

test("policy and preparation errors share status, retryable and schema enum entries", async () => {
  const codes = [
    ["preparation_not_found", 404, "not_found"],
    ["policy_revision_conflict", 409, "conflict"],
    ["request_id_conflict", 409, "conflict"],
    ["configuration_conflict", 409, "conflict"],
  ];
  const enumCodes = schema.$defs.error.properties.code.enum;
  for (const [code, status, category] of codes) {
    assert.equal(control.errors.status_by_code[code], status, code);
    assert.equal(control.errors.retryable_by_code[code], false, code);
    assert.ok(enumCodes.includes(code), code);
    const synthetic = {
      code,
      category,
      message: `synthetic ${code}`,
      retryable: false,
      request_id: "req-hygiene-1",
    };
    await valid(`${CONTROL_SCHEMA}#/$defs/error`, synthetic);
    await valid("common/error.schema.json", synthetic);
  }
});

test("status and status_rpc share the status response schema", async () => {
  assert.equal(control.status.response, STATUS_REF);
  assert.equal(control.status_rpc.response, STATUS_REF);
  const ref = `${CONTROL_SCHEMA}#/$defs/status`;
  await valid(ref, { status: "ready" });
  await valid(ref, { status: "not_ready" });
  await invalid(ref, { status: "degraded" });
  await invalid(ref, {});
});

test("created lifecycle shapes require activation_state that other states omit", async () => {
  const agentRef = `${CONTROL_SCHEMA}#/$defs/agent`;
  const base = loadGolden("agent-controller", "get-agent.ready.json");
  assert.equal(base.lifecycle_state, "created");
  await valid(agentRef, base);
  const created = structuredClone(base);
  delete created.activation_state;
  await invalid(agentRef, created);
  for (const lifecycle_state of ["not_created", "deleted"]) {
    const inactive = { ...created, lifecycle_state };
    await valid(agentRef, inactive);
    await invalid(agentRef, { ...inactive, activation_state: "enabled" });
  }
  await invalid(`${CONTROL_SCHEMA}#/$defs/agent_list`, {
    items: [created],
    next_cursor: null,
  });
  const operation = {
    request_id: "request-1",
    agent_id: "agent-1",
    kind: "create",
    phase: "network_ensure",
    state: "running",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
  await invalid(`${CONTROL_SCHEMA}#/$defs/create_agent_response`, {
    agent: created,
    operation,
  });
  await valid(`${CONTROL_SCHEMA}#/$defs/create_agent_response`, {
    agent: base,
    operation,
  });
});

test("workspace agent items apply the same activation_state condition", async () => {
  const ref = `${CONTROL_SCHEMA}#/$defs/list_workspace_agents_response`;
  const wrap = (agent) => ({ agents: [agent], next_cursor: null });
  const item = {
    agent_id: "agent-1",
    name: "Agent",
    runtime_state: "available",
  };
  await valid(
    ref,
    wrap({ ...item, lifecycle_state: "created", activation_state: "disabled" }),
  );
  await invalid(ref, wrap({ ...item, lifecycle_state: "created" }));
  for (const lifecycle_state of ["not_created", "deleted"]) {
    await valid(ref, wrap({ ...item, lifecycle_state }));
    await invalid(
      ref,
      wrap({ ...item, lifecycle_state, activation_state: "enabled" }),
    );
  }
});

test("historical readiness fixtures still validate against the schema", async () => {
  const agentRef = `${CONTROL_SCHEMA}#/$defs/agent`;
  await valid(agentRef, structuredClone(readinessFixtures.legacy_agent));
  for (const vector of readinessFixtures.readiness_vectors) {
    const agent = {
      ...structuredClone(readinessFixtures.legacy_agent),
      readiness: structuredClone(vector.value),
    };
    if (vector.valid) await valid(agentRef, agent);
    else await invalid(agentRef, agent);
  }
  const eventRef = `${CONTROL_SCHEMA}#/$defs/agent_event`;
  for (const vector of readinessFixtures.event_vectors) {
    const event = structuredClone(vector.value);
    if (vector.valid) await valid(eventRef, event);
    else await invalid(eventRef, event);
  }
});

test("the retired Run admission doc moved into service history", () => {
  assert.equal(
    existsSync(repoPath("contracts/agent-controller/run-api.md")),
    false,
  );
  const retirement =
    "services/agent-controller/docs/run-admission-retirement.md";
  assert.equal(existsSync(repoPath(retirement)), true);
  const markdown = repoText(retirement);
  assert.match(markdown, /acquire-run/);
  assert.match(markdown, /control-api\.md/);
  assert.deepEqual(brokenMarkdownLinks(repoDir, [retirement]), []);
});

test("contracts README directs to the current Controller catalog", () => {
  const readme = repoText("contracts/README.md");
  assert.match(readme, /agent-controller\/control-contract\.json/);
  assert.match(readme, /agent-controller\/control-api\.md/);
  assert.doesNotMatch(readme, /run-api/);
});

test("control-api.md records policy conflicts and preparation recovery", () => {
  for (const code of [
    "preparation_not_found",
    "policy_revision_conflict",
    "request_id_conflict",
    "configuration_conflict",
  ])
    assert.ok(controlApi.includes(code), `control-api.md omits ${code}`);
});
