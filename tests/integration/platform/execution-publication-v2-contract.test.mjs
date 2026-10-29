import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const contracts = new URL("../../../contracts/", import.meta.url);
const read = (path) =>
  JSON.parse(readFileSync(new URL(path, contracts), "utf8"));

const legacyId =
  "https://antnest.local/contracts/agent-acp/execution-snapshot.schema.json";
const publicationId =
  "https://antnest.local/contracts/agent-acp/execution-publication-v2.schema.json";
const credentialsId =
  "https://antnest.local/contracts/agent-controller/execution-credentials.schema.json";

function validators() {
  const legacy = read("agent-acp/execution-snapshot.schema.json");
  const publication = read("agent-acp/execution-publication-v2.schema.json");
  const credentials = read(
    "agent-controller/execution-credentials.schema.json",
  );
  assert.equal(legacy.$id, legacyId);
  assert.equal(publication.$id, publicationId);
  assert.equal(credentials.$id, credentialsId);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat("uri", {
    type: "string",
    validate: (value) => URL.canParse(value),
  });
  ajv.addSchema(legacy);
  ajv.addSchema(publication);
  ajv.addSchema(credentials);
  return (base, name) => {
    const validate = ajv.getSchema(`${base}#/$defs/${name}`);
    assert.equal(typeof validate, "function", `${base}#/$defs/${name}`);
    return validate;
  };
}

const digestHex = "a".repeat(64);

function enabledProvider() {
  return {
    connection_id: "conn-1",
    provider_key: "deepseek",
    request_protocol: "openai_chat_completions",
    base_url: "https://api.deepseek.example/v1",
    enabled: true,
    credential_revision: "credential-revision-1",
    credential: { ref: "conn-1", version: "credential-revision-1" },
  };
}

function disabledProvider() {
  return {
    connection_id: "conn-2",
    provider_key: "openrouter",
    request_protocol: "openai_chat_completions",
    base_url: "https://openrouter.example/api",
    enabled: false,
  };
}

function model() {
  return {
    model_profile_id: "model-1",
    connection_id: "conn-1",
    display_name: "DeepSeek Chat",
    enabled: true,
    model: "deepseek-chat",
    context_window: 65536,
    max_output_tokens: 8192,
    supports_images: false,
  };
}

function agent() {
  return {
    agent_id: "agent-1",
    principal_ids: ["principal-1"],
    access_revision: "access-1",
    accepting_runs: false,
    unavailable_reason: "agent_unavailable",
    operation_id: "operation-1",
    default_model_profile_id: "model-1",
    default_authorization: { mode: "auto", tool_rules: [] },
    authorization_revision: 1,
    agent_spec_revision: "spec-1",
    execution_revision: "execution-1",
    system_prompt: "",
    context_policy_version: "context-v1",
    skill_instructions: [],
    max_model_requests: 8,
    runtime: null,
  };
}

function budget() {
  return {
    revision: 1,
    unknown_cost: "deny",
    run_caps: {},
    daily: {},
    monthly: {},
  };
}

function snapshot(overrides = {}) {
  return {
    organization_id: "org-1",
    schema_version: 2,
    revision: 1,
    providers: [enabledProvider(), disabledProvider()],
    models: [model()],
    agents: [agent()],
    organization_budget: budget(),
    ...overrides,
  };
}

test("v2 snapshot admits minimal and representative organizations", () => {
  const validate = validators()(publicationId, "snapshot");
  const minimal = {
    organization_id: "org-1",
    schema_version: 2,
    revision: 1,
    providers: [],
    models: [],
    agents: [],
  };
  assert.equal(validate(minimal), true, JSON.stringify(validate.errors));
  assert.equal(validate(snapshot()), true, JSON.stringify(validate.errors));
});

test("v2 providers carry credential references and never plaintext secrets", () => {
  const validate = validators()(publicationId, "snapshot");
  const plaintext = snapshot({
    providers: [
      {
        ...enabledProvider(),
        credential: { method: "api_key", secret: "sk-1" },
      },
    ],
  });
  assert.equal(validate(plaintext), false);
  const secretField = snapshot({
    providers: [
      {
        ...enabledProvider(),
        credential: {
          ref: "conn-1",
          version: "credential-revision-1",
          secret: "sk-1",
        },
      },
    ],
  });
  assert.equal(validate(secretField), false);
  const missingCredential = snapshot();
  delete missingCredential.providers[0].credential;
  assert.equal(validate(missingCredential), false);
  const missingRevision = snapshot();
  delete missingRevision.providers[0].credential_revision;
  assert.equal(validate(missingRevision), false);
  const retained = snapshot({
    providers: [
      {
        ...disabledProvider(),
        credential_revision: "credential-revision-2",
        credential: { ref: "conn-2", version: "credential-revision-2" },
      },
    ],
  });
  assert.equal(validate(retained), true, JSON.stringify(validate.errors));
  const danglingReference = snapshot({
    providers: [
      { ...disabledProvider(), credential: { ref: "c", version: "r" } },
    ],
  });
  assert.equal(validate(danglingReference), false);
});

test("v2 snapshot requires schema_version 2 and closed collections", () => {
  const validate = validators()(publicationId, "snapshot");
  for (const version of [0, 1, 3, "2"]) {
    const body = snapshot({ schema_version: version });
    assert.equal(validate(body), false, `schema_version ${version}`);
  }
  const missingVersion = snapshot();
  delete missingVersion.schema_version;
  assert.equal(validate(missingVersion), false);
  const legacyPlaintext = snapshot();
  delete legacyPlaintext.schema_version;
  legacyPlaintext.providers = [
    { ...enabledProvider(), credential: { method: "api_key", secret: "sk-1" } },
  ];
  assert.equal(validate(legacyPlaintext), false);
  assert.equal(validate(snapshot({ unexpected: true })), false);
  const missingCollection = snapshot();
  delete missingCollection.providers;
  assert.equal(validate(missingCollection), false);
  assert.equal(validate(snapshot({ revision: 0 })), false);
  assert.equal(validate(snapshot({ revision: 9007199254740992 })), false);
});

test("v2 delta admits upserts and deletes and enforces closed revisions", () => {
  const validate = validators()(publicationId, "delta");
  const delta = {
    schema_version: 2,
    organization_id: "org-1",
    base_revision: 1,
    revision: 2,
    providers: { upserts: [enabledProvider()], deletes: ["conn-9"] },
    models: { upserts: [model()], deletes: [] },
    agents: { upserts: [], deletes: ["agent-7"] },
    organization_budget: null,
  };
  const before = structuredClone(delta);
  assert.equal(validate(delta), true, JSON.stringify(validate.errors));
  assert.deepEqual(delta, before);
  assert.equal(
    validate({ ...delta, organization_budget: budget() }),
    true,
    JSON.stringify(validate.errors),
  );
  for (const version of [undefined, 0, 1, 3]) {
    const body = { ...delta };
    if (version === undefined) delete body.schema_version;
    else body.schema_version = version;
    assert.equal(validate(body), false, `schema_version ${version}`);
  }
  assert.equal(validate({ ...delta, base_revision: 0 }), false);
  assert.equal(validate({ ...delta, revision: 0 }), false);
  assert.equal(validate({ ...delta, revision: 1 }), false);
  assert.equal(validate({ ...delta, revision: 9007199254740992 }), false);
  const missingModels = { ...delta };
  delete missingModels.models;
  assert.equal(validate(missingModels), false);
  const missingUpserts = structuredClone(delta);
  delete missingUpserts.providers.upserts;
  assert.equal(validate(missingUpserts), false);
  const duplicateDeletes = structuredClone(delta);
  duplicateDeletes.providers.deletes = ["conn-9", "conn-9"];
  assert.equal(validate(duplicateDeletes), false);
  assert.equal(validate({ ...delta, extra: 1 }), false);
  const plaintextUpsert = structuredClone(delta);
  plaintextUpsert.providers.upserts[0].credential = {
    method: "api_key",
    secret: "sk-1",
  };
  assert.equal(validate(plaintextUpsert), false);
});

test("digest request and response encode absent and current organizations", () => {
  const validate = validators();
  const request = validate(publicationId, "digest_request");
  assert.equal(request({ organization_id: "org-1" }), true);
  assert.equal(request({}), false);
  assert.equal(request({ organization_id: "org-1", revision: 1 }), false);

  const response = validate(publicationId, "digest_response");
  const absent = {
    organization_id: "org-1",
    schema_version: 0,
    revision: 0,
    digest: null,
    providers: [],
    models: [],
    agents: [],
    organization_budget_digest: null,
  };
  assert.equal(response(absent), true, JSON.stringify(response.errors));
  const current = {
    ...absent,
    schema_version: 2,
    revision: 9,
    digest: digestHex,
    providers: [{ id: "conn-1", digest: digestHex }],
    models: [{ id: "model-1", digest: digestHex }],
    agents: [{ id: "agent-1", digest: digestHex }],
    organization_budget_digest: digestHex,
  };
  assert.equal(response(current), true, JSON.stringify(response.errors));
  assert.equal(response({ ...current, schema_version: 3 }), false);
  assert.equal(response({ ...absent, revision: 5 }), false);
  assert.equal(response({ ...absent, digest: digestHex }), false);
  assert.equal(
    response({ ...absent, providers: [{ id: "conn-1", digest: digestHex }] }),
    false,
  );
  assert.equal(
    response({ ...absent, organization_budget_digest: digestHex }),
    false,
  );
  assert.equal(response({ ...current, digest: null }), false);
  assert.equal(response({ ...current, revision: 0 }), false);
  assert.equal(response({ ...current, digest: "not-hex" }), false);
  assert.equal(response({ ...current, revision: 9007199254740992 }), false);
  assert.equal(response({ ...current, providers: [{ id: "conn-1" }] }), false);
  const missingAgents = { ...current };
  delete missingAgents.agents;
  assert.equal(response(missingAgents), false);
  assert.equal(response({ ...current, extra: [] }), false);
});

test("credential resolve binds scope and returns only an api_key secret", () => {
  const validate = validators();
  const request = validate(credentialsId, "request");
  const scope = {
    organization_id: "org-1",
    connection_id: "conn-1",
    credential_version: "credential-revision-1",
  };
  assert.equal(request(scope), true);
  assert.equal(request({}), false);
  assert.equal(request({ ...scope, credential_version: "" }), false);
  assert.equal(request({ ...scope, secret: "sk-1" }), false);

  const response = validate(credentialsId, "response");
  assert.equal(response({ ...scope, method: "api_key", secret: "sk-1" }), true);
  assert.equal(response({ ...scope, method: "bearer", secret: "sk-1" }), false);
  assert.equal(response({ ...scope, method: "api_key", secret: "" }), false);
  assert.equal(response({ ...scope, method: "api_key" }), false);
  assert.equal(
    response({ ...scope, method: "api_key", secret: "sk-1", ttl_ms: 60000 }),
    false,
  );
});
