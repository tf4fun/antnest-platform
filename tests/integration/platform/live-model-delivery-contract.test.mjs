import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../contracts/", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const maximumSafeInteger = 9007199254740991;
const pinFields = [
  "model_profile_revision",
  "model_profile_revision_id",
  "pinned_model_profile_revision",
  "model_profile_pin",
];
const validCounts = [
  { templates: 0, agents: 0 },
  { templates: 2, agents: 3 },
  { templates: 150, agents: 200 },
  { templates: maximumSafeInteger, agents: maximumSafeInteger },
];
const invalidCounts = [
  { templates: -1, agents: 0 },
  { templates: 0 },
  { agents: 0 },
  { templates: null, agents: 1 },
  { templates: 1.5, agents: 0 },
  { templates: "2", agents: 0 },
  { templates: maximumSafeInteger + 1, agents: 0 },
];

const control = read("agent-controller/control-contract.json");
const controlApi = read("agent-controller/control-api.schema.json");
const controlCallers = read("agent-controller/callers.json");
const admin = read("admin-console/admin-contract.json");
const adminCallers = read("admin-console/callers.json");
const consoleDefs = read("admin-console/live-model-semantics.schema.json");
const auditSchema = read("agent-acp/execution-audit.schema.json");
const snapshotSchema = read("agent-acp/execution-snapshot.schema.json");

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema({
  $id: "https://antnest.local/contracts/admin-console/live-model-semantics.schema.json",
  $defs: consoleDefs.$defs,
});
const controllerUsage = ajv.compile(controlApi.$defs.model_profile_usage);
const browserUsage = ajv.compile(consoleDefs.$defs.model_profile_usage);
const effectiveModels = ajv.compile({
  $ref: "https://antnest.local/contracts/admin-console/live-model-semantics.schema.json#/$defs/effective_models",
});
const auditRevision = ajv.compile(auditSchema.properties.model_profile_revision);
const modelItemRevision = ajv.compile(
  snapshotSchema.properties.models.items.properties.model_profile_revision,
);

test("control revision 48 and admin version 59 declare the live model surface", () => {
  assert.equal(control.revision, 48);
  assert.equal(admin.version, 59);
  const upstream = control.resources.model_profiles.usage;
  assert.equal(upstream.path, "/internal/model-profiles/{model_profile_id}/usage");
  assert.deepEqual(upstream.query, ["organization_id"]);
  assert.equal(upstream.response, "control-api.schema.json#/$defs/model_profile_usage");
  const browser = admin.routes.get_model_profile_usage;
  assert.equal(browser.path, "/model-profiles/{model_profile_id}/usage");
  assert.equal(
    browser.response_schema,
    "live-model-semantics.schema.json#/$defs/model_profile_usage",
  );
  assert.equal(browser.query, "reject_all");
  assert.equal(browser.cache_control, "no-store");
});

test("caller policies scope the usage route to the verified admin chain", () => {
  const upstream =
    controlCallers.routes["GET /internal/model-profiles/{model_profile_id}/usage"];
  assert.deepEqual(upstream.caller_context, { "admin-console": "required" });
  assert.equal(upstream.request_body, "none");
  const browser =
    adminCallers.routes["GET /api/admin/model-profiles/{model_profile_id}/usage"];
  assert.deepEqual(browser.caller_context, { "edge-gateway": "required" });
  assert.equal(browser.request_body, "none");
});

test("Controller and BFF usage schemas accept and reject identical counts", () => {
  for (const counts of validCounts) {
    assert.ok(controllerUsage(counts), `Controller rejected ${JSON.stringify(counts)}`);
    assert.ok(browserUsage(counts), `BFF rejected ${JSON.stringify(counts)}`);
  }
  for (const counts of invalidCounts) {
    assert.equal(controllerUsage(counts), false, `Controller accepted ${JSON.stringify(counts)}`);
    assert.equal(browserUsage(counts), false, `BFF accepted ${JSON.stringify(counts)}`);
  }
});

test("live revision fragments stay bounded and pinning stays absent", () => {
  for (const models of [
    [{ model_profile_id: "model-1", revision: 1 }],
    [
      { model_profile_id: "model-1", revision: 2 },
      { model_profile_id: "model-2", revision: maximumSafeInteger },
    ],
  ]) assert.ok(effectiveModels(models));
  for (const models of [
    [],
    [{ model_profile_id: "", revision: 1 }],
    [{ model_profile_id: "model-1", revision: 0 }],
    [{ model_profile_id: "model-1", revision: maximumSafeInteger + 1 }],
    [{ model_profile_id: "model-1" }],
  ]) assert.equal(effectiveModels(models), false, JSON.stringify(models));
  for (const revision of [1, 7, maximumSafeInteger, null])
    assert.ok(auditRevision(revision));
  for (const revision of [0, 1.5, "7", maximumSafeInteger + 1])
    assert.equal(auditRevision(revision), false, String(revision));
  for (const revision of [1, 7, maximumSafeInteger])
    assert.ok(modelItemRevision(revision));
  for (const revision of [0, 1.5, "7", maximumSafeInteger + 1])
    assert.equal(modelItemRevision(revision), false, String(revision));

  for (const name of ["create_template_request", "revise_template_request"]) {
    const definition = controlApi.$defs[name];
    assert.ok(definition, `${name} must exist`);
    const text = JSON.stringify(definition);
    for (const field of pinFields)
      assert.equal(text.includes(`"${field}"`), false, `${field} appeared on ${name}`);
  }
});
