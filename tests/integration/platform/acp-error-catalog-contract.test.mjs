import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const ts = require("typescript");
const contractRoot = new URL("../../../contracts/agent-acp/", import.meta.url);
const catalog = JSON.parse(
  readFileSync(new URL("errors.json", contractRoot), "utf8"),
);
const schema = JSON.parse(
  readFileSync(new URL("errors.schema.json", contractRoot), "utf8"),
);
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validateCatalog = ajv.compile({ $ref: schema.$id });
const validateErrorData = ajv.compile({
  $ref: `${schema.$id}#/$defs/errorData`,
});

test("budget errors carry only closed, exact decimal accounting facts", () => {
  for (const scope of [
    "run_input",
    "run_output",
    "run_cost",
    "organization_daily",
    "organization_monthly",
    "unknown_cost",
  ]) {
    const budget =
      scope === "unknown_cost"
        ? { scope, limit: null, used: null }
        : { scope, limit: "9007199254740991", used: "90071992547409910001" };
    const data = {
      code: "budget_exceeded",
      retryable: false,
      details: { budget },
    };
    const original = structuredClone(data);
    assert.equal(
      validateErrorData(data),
      true,
      JSON.stringify(validateErrorData.errors),
    );
    assert.deepEqual(data, original);
  }
});

test("budget details cannot leak fields, coerce values or turn an accepted failure into retry", () => {
  const original = {
    code: "budget_exceeded",
    retryable: false,
    details: { budget: { scope: "run_cost", limit: "10", used: "11" } },
  };
  for (const change of [
    (v) => {
      v.code = "agent_busy";
    },
    (v) => {
      v.retryable = true;
    },
    (v) => {
      v.retry_after_ms = 1000;
    },
    (v) => {
      v.details.secret = "private";
    },
    (v) => {
      v.details.budget.secret = "private";
    },
    (v) => {
      v.details.budget.scope = "credential";
    },
    (v) => {
      delete v.details.budget.used;
    },
    (v) => {
      v.details.budget.limit = 10;
    },
    (v) => {
      v.details.budget.used = "01";
    },
    (v) => {
      v.details.budget.used = "-1";
    },
    (v) => {
      v.details.budget.used = "1e9";
    },
    (v) => {
      v.details.budget.used = "1.5";
    },
  ]) {
    const invalid = structuredClone(original);
    change(invalid);
    assert.equal(validateErrorData(invalid), false, JSON.stringify(invalid));
  }
  assert.equal(
    validateErrorData({ code: "budget_exceeded", retryable: false }),
    true,
  );
  assert.equal(
    validateErrorData({
      code: "budget_exceeded",
      retryable: false,
      details: {},
    }),
    true,
  );
  assert.equal(catalog.errors.budget_exceeded.json_rpc_code, -32043);
  assert.equal(catalog.terminal_outcomes.failed.json_rpc_code, -32022);
});

test("the shared ACP error catalog satisfies its complete schema", () => {
  assert.equal(
    validateCatalog(catalog),
    true,
    JSON.stringify(validateCatalog.errors),
  );
});

test("connection quota rejection is an HTTP-only retryable handshake error", () => {
  assert.deepEqual(catalog.errors.connection_quota_exceeded, {
    class: "resource",
    json_rpc_code: null,
    http_status: 429,
    retryable: true,
    retry_after_ms: 1000,
    recovery: "backoff",
    message: "Connection capacity is exhausted",
    surfaces: ["http"],
  });
});

test("configuration_base_mismatch is a non-retryable conflict recovering by refresh", () => {
  assert.deepEqual(catalog.errors.configuration_base_mismatch, {
    class: "conflict",
    json_rpc_code: -32050,
    http_status: 409,
    retryable: false,
    recovery: "refresh",
    message: "Execution authority base revision changed",
    surfaces: ["admission", "http"],
  });
});

test("not_found is a generic HTTP and Skill-source resource error without admission semantics", () => {
  const definition = catalog.errors.not_found;
  assert.deepEqual(
    { ...definition, surfaces: [...definition.surfaces].sort() },
    {
      class: "resource",
      json_rpc_code: null,
      http_status: 404,
      retryable: false,
      recovery: "refresh",
      message: "Resource was not found",
      surfaces: ["http", "skill_source"],
    },
  );
});

const invalidCatalogTransformations = [
  {
    name: "availability cannot use the access numeric range",
    mutate: (value) => {
      value.errors.agent_busy.json_rpc_code = -32010;
    },
  },
  {
    name: "access cannot use the availability numeric range",
    mutate: (value) => {
      value.errors.access_denied.json_rpc_code = -32030;
    },
  },
  {
    name: "configuration cannot use the conflict numeric range",
    mutate: (value) => {
      value.errors.model_unavailable.json_rpc_code = -32050;
    },
  },
  ...[-32020, -32022, -32023].map((code) => ({
    name: `admission cannot occupy reserved outcome/fallback ${code}`,
    mutate: (value) => {
      value.errors.agent_busy.json_rpc_code = code;
    },
  })),
  { name: "fallback is required", mutate: (value) => delete value.fallback },
  {
    name: "fallback cannot suggest retry",
    mutate: (value) => {
      value.fallback = { ...value.fallback, retryable: true };
    },
  },
  {
    name: "fallback message cannot expose an arbitrary cause",
    mutate: (value) => {
      value.fallback = {
        ...value.fallback,
        message: "private upstream failure",
      };
    },
  },
  {
    name: "schema version is required",
    mutate: (value) => delete value.schema_version,
  },
  {
    name: "unknown root fields are rejected",
    mutate: (value) => {
      value.unknown_field = true;
    },
  },
  {
    name: "unknown error classes are rejected",
    mutate: (value) => {
      value.errors.agent_busy.class = "unknown_class";
    },
  },
  {
    name: "JSON-RPC codes below the reserved range are rejected",
    mutate: (value) => {
      value.errors.agent_busy.json_rpc_code = -32701;
    },
  },
  {
    name: "JSON-RPC codes above the reserved range are rejected",
    mutate: (value) => {
      value.errors.agent_busy.json_rpc_code = -31999;
    },
  },
  {
    name: "JSON-RPC codes cannot be strings",
    mutate: (value) => {
      value.errors.agent_busy.json_rpc_code = "-32030";
    },
  },
  {
    name: "HTTP statuses below the error range are rejected",
    mutate: (value) => {
      value.errors.agent_busy.http_status = 399;
    },
  },
  {
    name: "HTTP statuses above the error range are rejected",
    mutate: (value) => {
      value.errors.agent_busy.http_status = 600;
    },
  },
  {
    name: "retry delay must be positive",
    mutate: (value) => {
      value.errors.agent_busy.retry_after_ms = 0;
    },
  },
  {
    name: "retry delay must be an integer",
    mutate: (value) => {
      value.errors.agent_busy.retry_after_ms = 1.5;
    },
  },
  {
    name: "retry delay cannot exceed its bound",
    mutate: (value) => {
      value.errors.agent_busy.retry_after_ms = 60001;
    },
  },
  {
    name: "a non-retryable catalog error cannot carry a retry delay",
    mutate: (value) => {
      value.errors.agent_busy.retryable = false;
    },
  },
  {
    name: "retry delay requires backoff recovery",
    mutate: (value) => {
      value.errors.agent_busy.recovery = "reconnect";
    },
  },
  {
    name: "an admission error requires a numeric JSON-RPC code",
    mutate: (value) => {
      value.errors.agent_busy.json_rpc_code = null;
    },
  },
  ...["failed", "unresolved"].flatMap((outcome) => [
    {
      name: `${outcome} terminal outcomes cannot be retryable`,
      mutate: (value) => {
        value.terminal_outcomes[outcome].retryable = true;
      },
    },
    {
      name: `${outcome} terminal outcomes retain their fixed JSON-RPC code`,
      mutate: (value) => {
        value.terminal_outcomes[outcome].json_rpc_code = -32021;
      },
    },
    {
      name: `${outcome} terminal classification vocabulary remains open`,
      mutate: (value) => {
        value.terminal_outcomes[outcome].data_code.vocabulary = "closed";
      },
    },
    {
      name: `${outcome} terminal outcomes cannot acquire an admission surface`,
      mutate: (value) => {
        value.terminal_outcomes[outcome].surfaces.push("admission");
      },
    },
  ]),
];

test("generic fallback has a fixed public envelope and cannot replay an accepted Run", () => {
  assert.deepEqual(catalog.fallback, {
    json_rpc_code: -32020,
    http_status: 500,
    data_code: "internal_error",
    retryable: false,
    recovery: "contact_operator",
    message: "Agent request failed",
  });
});

function collectDomainCodes(source, label) {
  const ast = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const codes = new Set();
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "DomainError"
    ) {
      const code = node.arguments?.[0];
      assert(
        code && ts.isStringLiteralLike(code),
        `${label}: DomainError code must be an explicit catalog literal`,
      );
      codes.add(code.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return codes;
}
function assertRegistered(source, value, label = "contract fixture") {
  const codes = collectDomainCodes(source, label);
  for (const code of codes)
    assert(
      Object.hasOwn(value.errors, code),
      `${label}: unregistered DomainError ${code}`,
    );
  return codes;
}
test("every literal ACP DomainError is covered by the shared catalog", () => {
  const root = new URL(
      "../../../services/agent-acp-service/src/",
      import.meta.url,
    ),
    all = new Set();
  for (const entry of readdirSync(root, { recursive: true })) {
    if (!entry.endsWith(".ts")) continue;
    for (const code of assertRegistered(
      readFileSync(new URL(entry, root), "utf8"),
      catalog,
      entry,
    ))
      all.add(code);
  }
  assert(
    all.has("agent_busy") &&
      all.has("configuration_not_ready") &&
      all.has("access_denied"),
  );
});
test("coverage rejects omitted, unknown and dynamically constructed DomainError codes", () => {
  const missing = structuredClone(catalog);
  delete missing.errors.agent_busy;
  assert.throws(
    () => assertRegistered('new DomainError("agent_busy", "busy")', missing),
    /unregistered/u,
  );
  assert.throws(
    () =>
      assertRegistered(
        'new DomainError("new_unregistered_error", "failure")',
        catalog,
      ),
    /unregistered/u,
  );
  assert.throws(
    () => assertRegistered('new DomainError(dynamicCode, "failure")', catalog),
    /explicit catalog literal/u,
  );
  assert.deepEqual(
    [
      ...assertRegistered(
        'new DomainError(\n  "agent_busy", "busy"\n)',
        catalog,
      ),
    ],
    ["agent_busy"],
  );
});

test("the catalog schema rejects invalid field transformations", async (context) => {
  for (const { name, mutate } of invalidCatalogTransformations) {
    await context.test(name, () => {
      const changed = structuredClone(catalog);
      mutate(changed);
      assert.equal(validateCatalog(changed), false, name);
    });
  }
});

const errorDataCases = [
  {
    name: "a permanent error carries its code and retry classification",
    valid: true,
    value: { code: "access_denied", retryable: false },
  },
  {
    name: "a retryable error can carry a bounded retry delay",
    valid: true,
    value: { code: "agent_busy", retryable: true, retry_after_ms: 1000 },
  },
  {
    name: "an empty details object is allowed",
    valid: true,
    value: { code: "access_denied", retryable: false, details: {} },
  },
  {
    name: "a non-retryable error cannot carry a delay",
    valid: false,
    value: { code: "access_denied", retryable: false, retry_after_ms: 1000 },
  },
  {
    name: "error data retry delay must be positive",
    valid: false,
    value: { code: "agent_busy", retryable: true, retry_after_ms: 0 },
  },
  {
    name: "error data retry delay must be an integer",
    valid: false,
    value: { code: "agent_busy", retryable: true, retry_after_ms: 1.5 },
  },
  {
    name: "error data retry delay cannot exceed its bound",
    valid: false,
    value: { code: "agent_busy", retryable: true, retry_after_ms: 60001 },
  },
  {
    name: "details cannot carry an arbitrary cause",
    valid: false,
    value: {
      code: "database_error",
      retryable: false,
      details: { cause: "unapproved detail" },
    },
  },
  {
    name: "details cannot carry a credential field",
    valid: false,
    value: {
      code: "access_denied",
      retryable: false,
      details: { credential: "unapproved detail" },
    },
  },
  {
    name: "undeclared error data fields are rejected",
    valid: false,
    value: { code: "agent_busy", retryable: true, unknown_field: true },
  },
];

test("error data uses the complete schema's referenced definition", async (context) => {
  for (const { name, valid, value } of errorDataCases) {
    await context.test(name, () => {
      assert.equal(
        validateErrorData(value),
        valid,
        `${name}: ${JSON.stringify(validateErrorData.errors)}`,
      );
    });
  }
});
