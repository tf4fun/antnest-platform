import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const contracts = new URL("../../../contracts/", import.meta.url);
const schemaPath = "agent-controller/provider-token-limits.schema.json";
const schemaId =
  "https://antnest.local/contracts/agent-controller/provider-token-limits.schema.json";
const read = (path) =>
  JSON.parse(readFileSync(new URL(path, contracts), "utf8"));

function checker() {
  const schema = read(schemaPath);
  assert.equal(schema.$id, schemaId);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const validate = ajv.compile(schema);
  return (value, expected = true, label = "provider token limits") => {
    const before = structuredClone(value);
    assert.equal(
      validate(value),
      expected,
      label + ": " + JSON.stringify(validate.errors),
    );
    assert.deepEqual(value, before, label + ": validator mutated its input");
  };
}

function limits() {
  return {
    source: "models",
    source_revision: 1,
    binding: {
      organization_id: "organization-1",
      connection_id: "connection-1",
      provider_key: "openai_compatible",
      request_protocol: "openai_chat_completions",
      base_url: "https://provider.example.test/v1",
      model: "text-model-1",
      credential_revision: "credential-1",
    },
    context_tokens: 8192,
    max_output_tokens: 1024,
    context_includes_media: false,
    output_includes_reasoning: false,
  };
}

test("the execution snapshot embeds the same closed observation schema", () => {
  const canonical = read(schemaPath);
  const inline = (value) => {
    if (Array.isArray(value)) return value.map(inline);
    if (value === null || typeof value !== "object") return value;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/$defs/"));
      return inline(canonical.$defs[value.$ref.split("/").at(-1)]);
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["$schema", "$id", "$defs", "title"].includes(key))
        .map(([key, item]) => [key, inline(item)]),
    );
  };
  const execution = read("agent-acp/execution-snapshot.schema.json");
  assert.deepEqual(execution.$defs.provider_token_limits, inline(canonical));
  assert.deepEqual(
    execution.properties.models.items.properties.provider_token_limits,
    { $ref: "#/$defs/provider_token_limits" },
  );
});

test("canonical provider token limits accept a complete text-only binding without mutation", () => {
  checker()(limits());
});

test("either positive token dimension can be supplied independently", () => {
  const check = checker();
  for (const omitted of ["context_tokens", "max_output_tokens"]) {
    const value = limits();
    delete value[omitted];
    check(value, true, "omitted " + omitted);
    assert.equal(Object.hasOwn(value, omitted), false);
  }
});

test("unknown media and reasoning coverage remains omitted while explicit booleans remain intact", () => {
  const check = checker();
  const unknown = limits();
  delete unknown.context_includes_media;
  delete unknown.output_includes_reasoning;
  check(unknown);
  assert.equal(Object.hasOwn(unknown, "context_includes_media"), false);
  assert.equal(Object.hasOwn(unknown, "output_includes_reasoning"), false);
  for (const flag of ["context_includes_media", "output_includes_reasoning"])
    for (const coverage of [false, true]) {
      const value = structuredClone(unknown);
      value[flag] = coverage;
      check(value);
      assert.equal(value[flag], coverage);
    }
});

test("the three supported Provider keys use the same closed binding", () => {
  const check = checker();
  for (const provider_key of ["deepseek", "openrouter", "openai_compatible"]) {
    const value = limits();
    value.binding.provider_key = provider_key;
    check(value);
  }
});

test("source revision and token dimensions accept the positive safe-integer endpoints", () => {
  const check = checker();
  for (const field of [
    "source_revision",
    "context_tokens",
    "max_output_tokens",
  ])
    for (const amount of [1, Number.MAX_SAFE_INTEGER]) {
      const value = limits();
      value[field] = amount;
      check(value, true, field);
    }
});

test("numeric bounds reject zero, negative, fractional, unsafe and coerced values", () => {
  const check = checker();
  for (const field of [
    "source_revision",
    "context_tokens",
    "max_output_tokens",
  ])
    for (const amount of [
      -1,
      -0,
      0,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      null,
      true,
      {},
      [],
    ]) {
      const value = limits();
      value[field] = amount;
      check(value, false, field);
    }
});

test("required root members and at least one actual token dimension cannot be omitted", () => {
  const check = checker();
  for (const field of ["source", "source_revision", "binding"]) {
    const value = limits();
    delete value[field];
    check(value, false, "missing " + field);
  }
  const empty = limits();
  delete empty.context_tokens;
  delete empty.max_output_tokens;
  check(empty, false, "no token dimensions");
  for (const value of [null, [], "models", 1])
    check(value, false, "non-object root");
  for (const binding of [null, [], "connection-1", 1, {}]) {
    const value = limits();
    value.binding = binding;
    check(value, false, "invalid binding");
  }
});

test("every frozen binding member is required", () => {
  const check = checker();
  for (const field of [
    "organization_id",
    "connection_id",
    "provider_key",
    "request_protocol",
    "base_url",
    "model",
    "credential_revision",
  ]) {
    const value = limits();
    delete value.binding[field];
    check(value, false, "missing binding." + field);
  }
});

test("organization, connection and credential revision identifiers retain Controller ID semantics", () => {
  const check = checker();
  const identity = read("agent-controller/control-api.schema.json").$defs.id;
  const validateId = new Ajv2020({ strict: true }).compile(identity);
  const accepted = ["id-1", "org.team_owner-1", "x".repeat(200)];
  const rejected = [
    "",
    "x".repeat(201),
    "org/team+owner@example.test",
    "bad id",
    "_id",
    null,
    1,
  ];
  for (const field of [
    "organization_id",
    "connection_id",
    "credential_revision",
  ])
    for (const [expected, examples] of [
      [true, accepted],
      [false, rejected],
    ])
      for (const example of examples) {
        assert.equal(validateId(example), expected, "existing Controller ID");
        const value = limits();
        value.binding[field] = example;
        check(value, expected, "binding." + field);
      }
});

test("unknown root and binding fields including private credentials are rejected without dropping them", () => {
  const check = checker();
  for (const field of [
    "unexpected",
    "credential",
    "credentials",
    "api_key",
    "headers",
    "secret",
  ]) {
    const root = limits();
    root[field] = "private-input-canary";
    check(root, false, "root." + field);
    const nested = limits();
    nested.binding[field] = "private-input-canary";
    check(nested, false, "binding." + field);
  }
});

test("source, request protocol, Provider key and coverage flags remain exact wire values", () => {
  const check = checker();
  for (const source of ["controller", "model", "", null, 1]) {
    const value = limits();
    value.source = source;
    check(value, false, "source");
  }
  for (const request_protocol of [
    "openai_responses",
    "anthropic_messages",
    "",
    null,
    1,
  ]) {
    const value = limits();
    value.binding.request_protocol = request_protocol;
    check(value, false, "request_protocol");
  }
  for (const provider_key of ["anthropic", "openai", "", null, 1]) {
    const value = limits();
    value.binding.provider_key = provider_key;
    check(value, false, "provider_key");
  }
  for (const field of ["context_includes_media", "output_includes_reasoning"])
    for (const flag of ["true", "false", 0, 1, null, {}, []]) {
      const value = limits();
      value[field] = flag;
      check(value, false, field);
    }
});

test("model and base URL checks cover wire shape while normalization remains a service check", () => {
  const check = checker();
  for (const model of ["text-model", "x".repeat(200)]) {
    const value = limits();
    value.binding.model = model;
    check(value);
  }
  for (const model of ["", "x".repeat(201), null, 1]) {
    const value = limits();
    value.binding.model = model;
    check(value, false, "model");
  }
  for (const base_url of [
    "http://127.0.0.1:8080/v1",
    "https://EXAMPLE.test:443/v1/",
  ]) {
    const value = limits();
    value.binding.base_url = base_url;
    check(value);
  }
  for (const base_url of [
    "",
    "ftp://provider.example.test/v1",
    "file:///tmp/model",
    "provider.example.test/v1",
    null,
    1,
  ]) {
    const value = limits();
    value.binding.base_url = base_url;
    check(value, false, "base_url");
  }
});
