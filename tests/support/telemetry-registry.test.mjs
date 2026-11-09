import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkTelemetrySource } from "../../scripts/check-telemetry-names.mjs";
import {
  renderGo,
  renderMarkdown,
  renderRust,
  renderTypeScript,
  validateRegistry,
} from "../../scripts/lib/telemetry-registry.mjs";

const validRegistry = () => ({
  schema_version: 1,
  attributes: [
    {
      name: "antnest.agent.id",
      kind: "span_attribute",
      type: "string",
      cardinality: "unbounded",
      pii: "identifier",
      owner: ["runtime-controller"],
    },
    {
      name: "antnest.agent_id",
      kind: "span_attribute",
      type: "string",
      cardinality: "unbounded",
      pii: "identifier",
      owner: ["runtime-controller"],
      deprecated_alias_of: "antnest.agent.id",
    },
    {
      name: "antnest.outcome",
      kind: "span_attribute",
      type: "string",
      cardinality: "low",
      pii: "none",
      owner: ["runtime-controller"],
    },
    {
      name: "antnest.example.requests",
      kind: "metric",
      type: "int",
      unit: "{request}",
      cardinality: "bounded",
      pii: "none",
      owner: ["runtime-controller"],
      labels: ["antnest.outcome"],
    },
    {
      name: "antnest.error",
      kind: "event",
      type: "string",
      cardinality: "bounded",
      pii: "none",
      owner: ["runtime-controller"],
    },
    {
      name: "antnest.payload.json",
      kind: "span_attribute",
      type: "string",
      cardinality: "unbounded",
      pii: "content",
      owner: ["runtime-controller"],
    },
    {
      name: "antnest_edge_login_admission_total",
      kind: "metric",
      type: "int",
      unit: "1",
      cardinality: "bounded",
      pii: "none",
      owner: ["edge-gateway"],
      legacy_metric_name: true,
    },
  ],
});

const attribute = (registry, name) =>
  registry.attributes.find((entry) => entry.name === name);

const mutated = (mutate) => {
  const registry = validRegistry();
  mutate(registry);
  return registry;
};

const lint = (source, path) =>
  checkTelemetrySource(source, path, validRegistry());

const assertProblems = (problems) => {
  assert.notDeepEqual(problems, []);
  for (const problem of problems) assert.equal(typeof problem, "string");
};

test("a registry covering every kind and metadata field validates cleanly", () => {
  assert.deepEqual(validateRegistry(validRegistry()), []);
});

test("registry validation rejects duplicates, invalid enums and absent owners", () => {
  const mutations = [
    (registry) => {
      attribute(registry, "antnest.agent.id").name = "antnest_agent_id";
    },
    (registry) =>
      registry.attributes.push({
        ...attribute(registry, "antnest.outcome"),
      }),
    (registry) => {
      attribute(registry, "antnest.agent.id").type = "float";
    },
    (registry) => {
      attribute(registry, "antnest.agent.id").cardinality = "medium";
    },
    (registry) => {
      attribute(registry, "antnest.agent.id").pii = "secret";
    },
    (registry) => {
      attribute(registry, "antnest.agent.id").kind = "log";
    },
    (registry) => {
      attribute(registry, "antnest.agent.id").owner = [];
    },
    (registry) => {
      attribute(registry, "antnest.agent.id").owner = "runtime-controller";
    },
    (registry) => {
      delete attribute(registry, "antnest.agent.id").owner;
    },
  ];
  for (const mutate of mutations)
    assertProblems(validateRegistry(mutated(mutate)));
});

test("registry validation rejects broken deprecated aliases", () => {
  const mutations = [
    (registry) => {
      attribute(registry, "antnest.agent_id").deprecated_alias_of =
        "antnest.undeclared";
    },
    (registry) => {
      attribute(registry, "antnest.agent_id").deprecated_alias_of =
        "antnest.agent_id";
    },
    (registry) => {
      attribute(registry, "antnest.agent_id").deprecated_alias_of =
        "antnest.error_v1";
      registry.attributes.push({
        name: "antnest.error_v1",
        kind: "event",
        type: "string",
        cardinality: "bounded",
        pii: "none",
        owner: ["runtime-controller"],
        deprecated_alias_of: "antnest.agent_id",
      });
    },
    (registry) => {
      attribute(registry, "antnest.agent_id").type = "int";
    },
    (registry) => {
      attribute(registry, "antnest.agent_id").kind = "event";
    },
    (registry) => {
      attribute(registry, "antnest.agent_id").unit = "ms";
    },
    (registry) => {
      attribute(registry, "antnest.agent_id").alternate_types = ["int"];
    },
  ];
  for (const mutate of mutations)
    assertProblems(validateRegistry(mutated(mutate)));
});

test("registry validation rejects unsafe metric declarations", () => {
  const mutations = [
    (registry) => {
      attribute(registry, "antnest.example.requests").labels = [
        "antnest.agent.id",
      ];
    },
    (registry) => {
      delete attribute(registry, "antnest.example.requests").unit;
    },
    (registry) => {
      attribute(registry, "antnest.outcome").pii = "content";
    },
    (registry) => {
      attribute(registry, "antnest.example.requests").labels = [
        "antnest.example.requests",
      ];
    },
    (registry) => {
      attribute(registry, "antnest.example.requests").labels = [
        "antnest.error",
      ];
    },
    (registry) => {
      attribute(registry, "antnest.example.requests").labels = [
        "antnest.payload.json",
      ];
    },
  ];
  for (const mutate of mutations)
    assertProblems(validateRegistry(mutated(mutate)));
});

test("renderers emit identical output when registry order changes", () => {
  const reversed = validRegistry();
  reversed.attributes.reverse();
  for (const render of [renderGo, renderTypeScript, renderRust, renderMarkdown])
    assert.equal(render(reversed), render(validRegistry()));
});

test("renderGo emits package telemetry with canonical and legacy constants", () => {
  const output = renderGo(validRegistry());
  assert.match(output, /\bpackage telemetry\b/);
  assert.match(output, /\bAntnestAgentId\b[^,;\n]*"antnest\.agent\.id"/);
  assert.match(output, /\bAntnestAgentIdLegacy\b[^,;\n]*"antnest\.agent_id"/);
  assert.match(output, /\bAntnestOutcome\b/);
  assert.match(output, /\bAntnestExampleRequests\b/);
  assert.match(output, /\bAntnestError\b/);
  assert.match(output, /\bvar DeprecatedAliases\b/);
  assert.match(output, /\bvalues\[AntnestAgentIdLegacy\] = AntnestAgentId\b/);
  assert.match(output, /\bvar RestrictedMetricAttributes\b/);
  assert.match(output, /\bvalues\[AntnestAgentId\] = true\b/);
  assert.match(output, /\bvalues\[AntnestAgentIdLegacy\] = true\b/);
  assert.match(output, /\bvalues\[AntnestPayloadJson\] = true\b/);
});

test("renderTypeScript emits a SEMCONV export with canonical and legacy constants", () => {
  const output = renderTypeScript(validRegistry());
  assert.match(output, /\bexport const SEMCONV\b/);
  assert.match(output, /\bANTNEST_AGENT_ID\b[^,;\n]*"antnest\.agent\.id"/);
  assert.match(
    output,
    /\bANTNEST_AGENT_ID_LEGACY\b[^,;\n]*"antnest\.agent_id"/,
  );
  assert.match(output, /\bANTNEST_OUTCOME\b/);
  assert.match(output, /\bANTNEST_EXAMPLE_REQUESTS\b/);
  assert.match(output, /\bANTNEST_ERROR\b/);
  assert.match(output, /\bexport const DEPRECATED_ALIASES\b/);
  assert.match(
    output,
    /\[SEMCONV\.ANTNEST_AGENT_ID_LEGACY\]:\s*SEMCONV\.ANTNEST_AGENT_ID\b/,
  );
  assert.match(output, /\bexport const RESTRICTED_METRIC_ATTRIBUTES\b/);
  assert.match(output, /\bSEMCONV\.ANTNEST_PAYLOAD_JSON,/);
});

test("renderRust emits pub const canonical and legacy constants", () => {
  const output = renderRust(validRegistry());
  assert.match(output, /\bpub const\b/);
  assert.match(output, /\bANTNEST_AGENT_ID\b[^,;\n]*"antnest\.agent\.id"/);
  assert.match(
    output,
    /\bANTNEST_AGENT_ID_LEGACY\b[^,;\n]*"antnest\.agent_id"/,
  );
  assert.match(output, /\bANTNEST_OUTCOME\b/);
  assert.match(output, /\bANTNEST_EXAMPLE_REQUESTS\b/);
  assert.match(output, /\bANTNEST_ERROR\b/);
  assert.match(output, /pub const DEPRECATED_ALIASES: &\[\(&str, &str\)\]/);
  assert.match(output, /\(ANTNEST_AGENT_ID_LEGACY, ANTNEST_AGENT_ID\)/);
  assert.match(output, /pub const RESTRICTED_METRIC_ATTRIBUTES: &\[&str\]/);
  const restricted = output.split("pub const RESTRICTED_METRIC_ATTRIBUTES")[1];
  assert.ok(restricted?.includes("ANTNEST_AGENT_ID,"));
  assert.ok(restricted?.includes("ANTNEST_AGENT_ID_LEGACY,"));
  assert.ok(restricted?.includes("ANTNEST_PAYLOAD_JSON,"));
  assert.ok(!restricted?.includes("ANTNEST_OUTCOME,"));
});

test("renderMarkdown records attribute metadata and alias targets", () => {
  const output = renderMarkdown(validRegistry());
  assert.match(output, /antnest\.agent\.id/);
  assert.match(output, /antnest\.example\.requests/);
  assert.match(output, /antnest\.error/);
  assert.match(output, /unbounded/);
  assert.match(output, /identifier/);
  assert.match(output, /\{request\}/);
  assert.match(output, /runtime-controller/);
  assert.ok(
    output
      .split("\n")
      .some(
        (line) =>
          line.includes("antnest.agent_id") &&
          line.includes("antnest.agent.id"),
      ),
    "markdown must relate each deprecated alias to its canonical target",
  );
});

test("source lint accepts registry constants, external names and plain code", () => {
  const clean = [
    [
      "span.SetAttributes(attribute.String(semconv.AntnestAgentId, agentID))",
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      "span.AddEvent(semconv.AntnestError)",
      "services/edge-gateway/internal/telemetry/errors.go",
    ],
    [
      "span.setAttribute(SEMCONV.ANTNEST_AGENT_ID, agentId)",
      "services/agent-acp-service/src/telemetry.ts",
    ],
    [
      "span.set_attribute(KeyValue::new(semconv::ANTNEST_AGENT_ID, agent_id))",
      "services/runtime-egress/src/telemetry.rs",
    ],
    [
      'span.SetAttributes(attribute.String("http.request.method", method))',
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    ["const retries = 3;", "services/agent-acp-service/src/config.ts"],
  ];
  for (const [source, path] of clean) assert.deepEqual(lint(source, path), []);
});

test("source lint rejects literal antnest names in Go, TypeScript and Rust", () => {
  const rejected = [
    [
      'span.SetAttributes(attribute.String("antnest.agent.id", agentID))',
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      "span.SetAttributes(attribute.String(`antnest.agent.id`, agentID))",
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      'span.SetAttributes(attribute.String("antnest.agent_id", agentID))',
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      'span.SetAttributes(attribute.String("antnest.undeclared", agentID))',
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      'span.setAttribute("antnest.agent.id", agentId)',
      "services/agent-acp-service/src/telemetry.ts",
    ],
    [
      "span.setAttribute('antnest.agent.id', agentId)",
      "services/agent-acp-service/src/telemetry.ts",
    ],
    [
      "span.setAttribute(`antnest.agent.id`, agentId)",
      "services/agent-acp-service/src/telemetry.ts",
    ],
    [
      'span.set_attribute(KeyValue::new("antnest.agent.id", agent_id))',
      "services/runtime-egress/src/telemetry.rs",
    ],
    ['const AntnestAgentId = "antnest.agent.id"', "vendor/semconv_gen.go"],
  ];
  for (const [source, path] of rejected) assertProblems(lint(source, path));
});

test("source lint rejects dynamically built antnest names", () => {
  const rejected = [
    [
      'span.SetAttributes(attribute.String("antnest." + direction, value))',
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      'span.setAttribute("antnest." + direction, value)',
      "services/agent-acp-service/src/telemetry.ts",
    ],
    [
      'let name = "antnest." + direction;',
      "services/runtime-egress/src/telemetry.rs",
    ],
  ];
  for (const [source, path] of rejected) assertProblems(lint(source, path));
});

test("source lint permits generated files, comments and test sources", () => {
  const clean = [
    [
      'const AntnestAgentId = "antnest.agent.id"',
      "libs/go/telemetry/semconv_gen.go",
    ],
    [
      'export const SEMCONV = { ANTNEST_AGENT_ID: "antnest.agent.id" } as const;',
      "services/agent-acp-service/src/telemetry/semconv.gen.ts",
    ],
    [
      'pub const ANTNEST_AGENT_ID: &str = "antnest.agent.id";',
      "services/runtime-egress/src/semconv.rs",
    ],
    [
      '// span.SetAttributes(attribute.String("antnest.agent.id", id))',
      "services/edge-gateway/internal/telemetry/http.go",
    ],
    [
      'span.SetAttributes(attribute.String("antnest.agent.id", id))',
      "services/edge-gateway/internal/telemetry/http_test.go",
    ],
    [
      'span.setAttribute("antnest.agent.id", agentId)',
      "services/agent-acp-service/src/telemetry.test.ts",
    ],
    [
      'assert_eq!(name, "antnest.agent.id");',
      "services/runtime-egress/src/control/observation_tests.rs",
    ],
    [
      'assert.ok(source.includes("antnest.agent.id"))',
      "tests/support/telemetry-registry.test.mjs",
    ],
  ];
  for (const [source, path] of clean) assert.deepEqual(lint(source, path), []);
});

test("source lint rejects restricted attributes used as metric labels", () => {
  const rejected = [
    [
      "requests.Add(1, metric.WithAttributes(attribute.String(semconv.AntnestAgentId, agentID)))",
      "services/edge-gateway/internal/telemetry/metrics.go",
    ],
    [
      "requests.Add(1, metric.WithAttributes(attribute.String(semconv.AntnestPayloadJson, payload)))",
      "services/edge-gateway/internal/telemetry/metrics.go",
    ],
    [
      "counter.add(1, { [SEMCONV.ANTNEST_AGENT_ID]: agentId })",
      "services/agent-acp-service/src/metrics.ts",
    ],
    [
      "counter.add(1, { [SEMCONV.ANTNEST_AGENT_ID_LEGACY]: agentId })",
      "services/agent-acp-service/src/metrics.ts",
    ],
    [
      "counter.add(1, { [SEMCONV.ANTNEST_PAYLOAD_JSON]: payload })",
      "services/agent-acp-service/src/metrics.ts",
    ],
    [
      "counter.add(1, &[KeyValue::new(semconv::ANTNEST_AGENT_ID, agent_id)])",
      "services/runtime-egress/src/metrics.rs",
    ],
  ];
  for (const [source, path] of rejected) assertProblems(lint(source, path));
});

test("source lint permits bounded attributes as metric labels", () => {
  const clean = [
    [
      "requests.Add(1, metric.WithAttributes(attribute.String(semconv.AntnestOutcome, outcome)))",
      "services/edge-gateway/internal/telemetry/metrics.go",
    ],
    [
      "counter.add(1, { [SEMCONV.ANTNEST_OUTCOME]: outcome })",
      "services/agent-acp-service/src/metrics.ts",
    ],
    [
      "counter.add(1, &[KeyValue::new(semconv::ANTNEST_OUTCOME, outcome)])",
      "services/runtime-egress/src/metrics.rs",
    ],
  ];
  for (const [source, path] of clean) assert.deepEqual(lint(source, path), []);
});

test("the published registry validates and shared Go output is regenerated", () => {
  const registry = JSON.parse(
    readFileSync(
      new URL("../../contracts/observability/attributes.yaml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(validateRegistry(registry), []);
  const completion = registry.attributes.find(
    (entry) => entry.name === "antnest.transaction.completion",
  );
  assert.ok(completion);
  assert.equal(completion.kind, "span_attribute");
  assert.equal(completion.cardinality, "low");
  assert.equal(completion.pii, "none");
  assert.equal(completion.deprecated_alias_of, undefined);
  assert.ok(completion.owner.includes("runtime-egress"));
  const generated = readFileSync(
    new URL("../../libs/go/telemetry/semconv_gen.go", import.meta.url),
    "utf8",
  );
  assert.equal(generated, renderGo(registry));
});

test("lint flags registered legacy metric literals but not other antnest_ names", () => {
  const flagged = checkTelemetrySource(
    'package x\nvar _ = "antnest_edge_login_admission_total"\n',
    "svc/main.go",
    validRegistry(),
  );
  assert.equal(flagged.length, 1);
  const allowed = checkTelemetrySource(
    'package x\nvar _ = "antnest_session"\n',
    "svc/main.go",
    validRegistry(),
  );
  assert.deepEqual(allowed, []);
});
