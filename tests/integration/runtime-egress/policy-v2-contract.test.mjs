import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const read = (base) => (name) =>
  JSON.parse(readFileSync(new URL(base + name, import.meta.url)));
const readEgress = read("../../../contracts/egress/");
const readController = read("../../../contracts/agent-controller/");
const ajv = () => new Ajv2020({ formats: { "date-time": true, uri: true } });

const v1Allow = { schema_version: 1, action: "allow_all" };
const v1Deny = { schema_version: 1, action: "deny_all" };
const v2Empty = { schema_version: 2, default: "deny", rules: [] };
const v2Policy = {
  schema_version: 2,
  default: "deny",
  rules: [
    {
      action: "allow",
      domains: ["api.github.com"],
      ports: [443],
      protocol: "tcp",
    },
    { action: "allow", cidrs: ["10.20.0.15/32"], ports: [443] },
    { action: "deny", ports: [25] },
  ],
};
const v2Ranges = {
  schema_version: 2,
  default: "allow",
  rules: [
    {
      action: "allow",
      domains: ["packages.internal.example.com"],
      ports: [{ from: 8000, to: 9000 }],
      protocol: "tcp",
    },
    { action: "allow", cidrs: ["192.168.10.0/24"] },
    { action: "deny" },
  ],
};

const valid = [
  v1Allow,
  v1Deny,
  v2Empty,
  { schema_version: 2, default: "allow", rules: [] },
  v2Policy,
  v2Ranges,
  {
    schema_version: 2,
    default: "deny",
    rules: Array(128).fill({ action: "deny" }),
  },
];

const rule = (r) => ({ schema_version: 2, default: "deny", rules: [r] });

const invalid = [
  { schema_version: 3, default: "deny", rules: [] },
  { schema_version: 2, action: "allow_all" },
  { schema_version: 1, default: "deny", rules: [] },
  { schema_version: 2, default: "allow_all", rules: [] },
  { ...v2Empty, comment: "any" },
  { schema_version: 2, default: "deny" },
  { schema_version: 2, rules: [] },
  {
    schema_version: 2,
    default: "deny",
    rules: Array(129).fill({ action: "deny" }),
  },
  rule({ action: "allow", protocol: "udp" }),
  rule({ action: "permit" }),
  rule({ ports: [443] }),
  rule({ action: "allow", priority: 1 }),
  rule({ action: "allow", cidrs: [] }),
  rule({ action: "allow", domains: [] }),
  rule({ action: "allow", ports: [] }),
  rule({ action: "allow", cidrs: Array(65).fill("10.0.0.0/8") }),
  rule({ action: "allow", domains: Array(65).fill("a.example.com") }),
  rule({ action: "allow", ports: Array(65).fill(443) }),
  rule({
    action: "allow",
    cidrs: ["10.0.0.0/8"],
    domains: ["example.com"],
  }),
  ...[
    "10.0.0.0/33",
    "10.0.0.0/08",
    "010.0.0.0/8",
    "10.0.0.1",
    "256.0.0.0/8",
    "10.0.0.0/",
    "::1/64",
  ].map((cidr) => rule({ action: "deny", cidrs: [cidr] })),
  ...[
    "*.example.com",
    "Example.COM",
    "localhost",
    "example.com.",
    "-example.com",
    "example-.com",
    "example..com",
    "exa_mple.com",
    "a".repeat(64) + ".com",
    ["a", "b", "c", "d"].map((l) => l.repeat(63)).join(".") + ".example.com",
  ].map((domain) => rule({ action: "allow", domains: [domain] })),
  ...[0, 65536, -1, 1.5, "443"].map((port) =>
    rule({ action: "allow", ports: [port] }),
  ),
  rule({ action: "allow", ports: [{ from: 0, to: 80 }] }),
  rule({ action: "allow", ports: [{ from: 80, to: 65536 }] }),
  rule({ action: "allow", ports: [{ from: 80 }] }),
  rule({ action: "allow", ports: [{ to: 80 }] }),
  rule({ action: "allow", ports: [{ from: 80, to: 90, label: "x" }] }),
  rule({ action: "allow", ports: [{ from: "80", to: 90 }] }),
];

test("Egress policy schema accepts v1 shapes and strict v2 rules", () => {
  const validate = ajv().compile(readEgress("policy.schema.json"));
  for (const value of valid)
    assert(validate(value), JSON.stringify(validate.errors));
  for (const value of invalid)
    assert.equal(validate(value), false, JSON.stringify(value));
  assert(readEgress("control-contract.json").revision > 8);
});

test("Controller network_policy_spec is identical to the Egress policy schema", () => {
  const egressSchema = readEgress("policy.schema.json");
  const controllerSchema = readController("control-api.schema.json");
  const stripped = Object.fromEntries(
    Object.entries(egressSchema).filter(
      ([key]) => !["$schema", "$id", "title"].includes(key),
    ),
  );
  assert.deepEqual(controllerSchema.$defs.network_policy_spec, stripped);
  const egress = ajv().compile(egressSchema);
  const spec = ajv().compile({
    ...controllerSchema,
    $ref: "#/$defs/network_policy_spec",
  });
  for (const value of valid) {
    assert(spec(value), JSON.stringify(spec.errors));
    assert(egress(value), JSON.stringify(egress.errors));
  }
  for (const value of invalid)
    assert.equal(spec(value), egress(value), JSON.stringify(value));
  assert(readController("control-contract.json").revision > 48);
});

test("Controller set_agent_network_policy_request accepts reference or spec tuple, not both", () => {
  const validate = ajv().compile({
    ...readController("control-api.schema.json"),
    $ref: "#/$defs/set_agent_network_policy_request",
  });
  const base = {
    request_id: "request-network-1",
    organization_id: "org-1",
    actor_principal_id: "admin-1",
    expected_resource_version: 3,
  };
  const reference = { ...base, policy_id: "builtin/deny-all", revision: 1 };
  for (const value of [
    reference,
    { ...base, spec: v1Allow },
    { ...base, spec: v2Policy },
  ])
    assert(validate(value), JSON.stringify(validate.errors));
  for (const value of [
    { ...reference, spec: v1Allow },
    { ...base, policy_id: "org/custom", spec: v2Policy },
    base,
    { ...base, policy_id: "builtin/deny-all" },
    { ...base, revision: 1 },
    { ...base, spec: v1Allow, revision: 1 },
    { ...base, spec: v1Allow, expected_resource_version: 0 },
    { ...reference, expected_resource_version: 0 },
    { ...base, policy_id: "builtin/deny-all", revision: 0 },
    { ...reference, digest: "sha256:" + "a".repeat(64) },
    { ...base, spec: { schema_version: 2, default: "deny" } },
  ])
    assert.equal(validate(value), false, JSON.stringify(value));
});
