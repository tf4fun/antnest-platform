import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { selectComponents } from "./ci-impact.mjs";
import { fileURLToPath } from "node:url";

import {
  renderGo,
  renderRust,
  renderTypeScript,
  validateRegistry,
} from "../../scripts/generate-api-errors.mjs";

const root = new URL("../..", import.meta.url);
const generator = fileURLToPath(
  new URL("scripts/generate-api-errors.mjs", root),
);

const categories = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "precondition_failed",
  "rate_limited",
  "unavailable",
  "internal",
];

const canonicalAliases = {
  internal_error: "internal",
  unauthorized: "unauthenticated",
  version_conflict: "conflict",
  resource_version_conflict: "conflict",
  revision_conflict: "conflict",
  request_conflict: "conflict",
};

function readJSON(relative) {
  return JSON.parse(readFileSync(new URL(relative, root), "utf8"));
}

function entry(code, overrides = {}) {
  return {
    code,
    category: "internal",
    retryable: false,
    http_status: 500,
    owner: "platform",
    description: `${code} description.`,
    ...overrides,
  };
}

function validRegistry() {
  return {
    version: 1,
    categories: [...categories],
    errors: [
      entry("invalid_request", {
        category: "invalid_request",
        http_status: 400,
        owner: "edge-gateway",
      }),
      entry("unauthenticated", {
        category: "unauthenticated",
        http_status: 401,
        owner: "identity",
      }),
      entry("unauthorized", {
        category: "unauthenticated",
        http_status: 401,
        owner: "identity",
        deprecated_alias_of: "unauthenticated",
      }),
      entry("not_found", {
        category: "not_found",
        http_status: 404,
      }),
      entry("conflict", {
        category: "conflict",
        http_status: 409,
      }),
      entry("version_conflict", {
        category: "conflict",
        http_status: 409,
        deprecated_alias_of: "conflict",
      }),
      entry("widget_not_found", {
        category: "not_found",
        http_status: 404,
        owner: "skill-registry",
      }),
      entry("widget_already_exists", {
        category: "conflict",
        http_status: 409,
        owner: "skill-registry",
      }),
      entry("backend_down", {
        category: "unavailable",
        retryable: true,
        http_status: 503,
        owner: "skill-registry",
      }),
      entry("widget_precondition_failed", {
        category: "precondition_failed",
        http_status: 412,
        owner: "skill-registry",
      }),
      entry("internal", {
        category: "internal",
        http_status: 500,
      }),
      entry("internal_error", {
        category: "internal",
        http_status: 500,
        deprecated_alias_of: "internal",
      }),
    ],
  };
}

function expectProblems(registry, pattern) {
  const problems = validateRegistry(registry);
  assert.ok(Array.isArray(problems), "problems are returned as an array");
  assert.ok(problems.length > 0, "the mutation is reported");
  assert.match(JSON.stringify(problems), pattern);
}

const pascalCase = (code) =>
  code
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
const upperSnake = (code) => code.toUpperCase();

const renderers = [
  ["go", renderGo, pascalCase],
  ["typescript", renderTypeScript, upperSnake],
  ["rust", renderRust, upperSnake],
];

test("the common error contracts are checked in", () => {
  for (const relative of [
    "contracts/common/error.schema.json",
    "contracts/common/errors.json",
  ])
    assert.ok(existsSync(new URL(relative, root)), `${relative} exists`);
});

test("the error envelope schema is a draft 2020-12 object", () => {
  const schema = readJSON("contracts/common/error.schema.json");
  assert.match(schema.$schema, /2020-12/);
  assert.equal(schema.type, "object");
  assert.deepEqual([...schema.required].sort(), [
    "category",
    "code",
    "message",
    "request_id",
    "retryable",
  ]);
  assert.notEqual(schema.additionalProperties, false);
});

test("the error envelope schema declares snake_case fields and the category enum", () => {
  const schema = readJSON("contracts/common/error.schema.json");
  const snakeCase = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
  for (const name of Object.keys(schema.properties))
    assert.match(name, snakeCase, `${name} is snake_case`);
  assert.equal(schema.properties.code.type, "string");
  assert.equal(schema.properties.category.type, "string");
  assert.equal(schema.properties.message.type, "string");
  assert.equal(schema.properties.retryable.type, "boolean");
  assert.equal(schema.properties.request_id.type, "string");
  assert.deepEqual(
    [...schema.properties.category.enum].sort(),
    [...categories].sort(),
  );
});

test("the error envelope schema keeps details as an optional object", () => {
  const schema = readJSON("contracts/common/error.schema.json");
  assert.equal(schema.properties.details.type, "object");
  assert.ok(!schema.required.includes("details"));
});

test("the checked-in registry is version 1 and lists every category", () => {
  const registry = readJSON("contracts/common/errors.json");
  assert.equal(registry.version, 1);
  assert.deepEqual([...registry.categories].sort(), [...categories].sort());
  assert.ok(Array.isArray(registry.errors));
  assert.ok(registry.errors.length > 0);
});

test("the checked-in registry validates cleanly", () => {
  const registry = readJSON("contracts/common/errors.json");
  assert.deepEqual(validateRegistry(registry), []);
});

test("the checked-in registry carries a canonical code per category", () => {
  const registry = readJSON("contracts/common/errors.json");
  for (const category of categories) {
    const canonical = registry.errors.find((error) => error.code === category);
    assert.ok(canonical, `${category} has a canonical code`);
    assert.equal(canonical.category, category);
  }
});

test("the checked-in registry keeps the deprecated canonical aliases", () => {
  const registry = readJSON("contracts/common/errors.json");
  for (const [alias, target] of Object.entries(canonicalAliases)) {
    const deprecated = registry.errors.find((error) => error.code === alias);
    assert.ok(deprecated, `${alias} is registered`);
    assert.equal(deprecated.deprecated_alias_of, target);
  }
});

test("checked-in service slices only declare registered codes", (t) => {
  const slicesDir = new URL("contracts/common/slices/", root);
  if (!existsSync(slicesDir)) {
    t.skip("no service slices are checked in yet");
    return;
  }
  const registry = readJSON("contracts/common/errors.json");
  const declared = new Set(registry.errors.map((error) => error.code));
  for (const file of readdirSync(slicesDir)) {
    if (!file.endsWith(".json")) continue;
    const slice = JSON.parse(readFileSync(new URL(file, slicesDir), "utf8"));
    assert.equal(slice.service, file.slice(0, -".json".length));
    assert.ok(Array.isArray(slice.codes) && slice.codes.length > 0);
    assert.equal(new Set(slice.codes).size, slice.codes.length);
    for (const code of slice.codes)
      assert.ok(
        declared.has(code),
        `${slice.service} declares unregistered ${code}`,
      );
  }
});

test("the generator CLI --check validates the checked-in contracts", () => {
  const result = spawnSync(process.execPath, [generator, "--check"], {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the generator CLI refuses a service without a slice", () => {
  const result = spawnSync(
    process.execPath,
    [generator, "--service", "no_such_service"],
    { cwd: fileURLToPath(root), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
});

test("the generator CLI --check rejects unknown or missing slices", () => {
  const unknown = spawnSync(
    process.execPath,
    [generator, "--check", "--service", "no_such_service"],
    { cwd: fileURLToPath(root), encoding: "utf8" },
  );
  assert.notEqual(unknown.status, 0, "no_such_service must be rejected");
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "api-errors-cli-")));
  try {
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "contracts", "common"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("scripts/generate-api-errors.mjs", root)),
      join(fixture, "scripts", "generate-api-errors.mjs"),
    );
    for (const name of ["errors.json", "error.schema.json"]) {
      copyFileSync(
        fileURLToPath(new URL(join("contracts", "common", name), root)),
        join(fixture, "contracts", "common", name),
      );
    }
    const missing = spawnSync(
      process.execPath,
      [
        join(fixture, "scripts", "generate-api-errors.mjs"),
        "--check",
        "--service",
        "identity-service",
      ],
      { cwd: fixture, encoding: "utf8" },
    );
    assert.notEqual(
      missing.status,
      0,
      "identity-service must be rejected without a slice",
    );
    assert.match(
      missing.stderr,
      /contracts\/common\/slices\/identity-service\.json is not checked in/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a well-formed registry validates cleanly", () => {
  assert.deepEqual(validateRegistry(validRegistry()), []);
});

test("a registry without version 1 is rejected", () => {
  const registry = validRegistry();
  registry.version = 2;
  expectProblems(registry, /version/);
});

test("duplicate codes are rejected", () => {
  const registry = validRegistry();
  registry.errors.push({ ...registry.errors.at(-1) });
  expectProblems(registry, /duplicate|unique/);
});

test("an entry without a category is rejected", () => {
  const registry = validRegistry();
  delete registry.errors[0].category;
  expectProblems(registry, /category/);
});

test("an entry with an undeclared category is rejected", () => {
  const registry = validRegistry();
  registry.errors[0].category = "bogus";
  expectProblems(registry, /category/);
});

test("an entry without a boolean retryable is rejected", () => {
  const missing = validRegistry();
  delete missing.errors[0].retryable;
  expectProblems(missing, /retryable/);
  const nonBoolean = validRegistry();
  nonBoolean.errors[0].retryable = "yes";
  expectProblems(nonBoolean, /retryable/);
});

test("an entry with an invalid http_status is rejected", () => {
  for (const status of [199, 600, 404.5, "404"]) {
    const registry = validRegistry();
    registry.errors[0].http_status = status;
    expectProblems(registry, /http_status|status/);
  }
});

test("an entry without a non-empty owner or description is rejected", () => {
  const missingOwner = validRegistry();
  delete missingOwner.errors[0].owner;
  expectProblems(missingOwner, /owner/);
  const emptyOwner = validRegistry();
  emptyOwner.errors[0].owner = "";
  expectProblems(emptyOwner, /owner/);
  const emptyDescription = validRegistry();
  emptyDescription.errors[0].description = "";
  expectProblems(emptyDescription, /description/);
});

test("a code that is not snake_case is rejected", () => {
  for (const code of ["WidgetNotFound", "widget--bad", "widget__bad", "_w"]) {
    const registry = validRegistry();
    registry.errors[0].code = code;
    expectProblems(registry, /code|snake/);
  }
});

test("an alias naming a missing target is rejected", () => {
  const registry = validRegistry();
  const alias = registry.errors.find(
    (error) => error.code === "internal_error",
  );
  alias.deprecated_alias_of = "no_such_code";
  expectProblems(registry, /alias|target/);
});

test("a self-referencing alias is rejected", () => {
  const registry = validRegistry();
  const alias = registry.errors.find(
    (error) => error.code === "internal_error",
  );
  alias.deprecated_alias_of = "internal_error";
  expectProblems(registry, /alias|self/);
});

test("an alias cycle is rejected", () => {
  const registry = validRegistry();
  registry.errors.push(
    entry("alias_a", { deprecated_alias_of: "alias_b" }),
    entry("alias_b", { deprecated_alias_of: "alias_a" }),
  );
  expectProblems(registry, /alias|cycle/);
});

test("an alias pointing at another alias is rejected", () => {
  const registry = validRegistry();
  registry.errors.push(
    entry("internal_fault", { deprecated_alias_of: "internal_error" }),
  );
  expectProblems(registry, /alias/);
});

test("an alias in a different category than its target is rejected", () => {
  const registry = validRegistry();
  const alias = registry.errors.find(
    (error) => error.code === "internal_error",
  );
  alias.category = "unavailable";
  expectProblems(registry, /alias|category/);
});

test("the registry categories are exactly the canonical nine", () => {
  const removed = validRegistry();
  removed.categories = removed.categories.filter(
    (category) => category !== "internal",
  );
  expectProblems(removed, /categor/);
  const added = validRegistry();
  added.categories.push("extra_category");
  expectProblems(added, /categor/);
});

test("canonical internal invariants are enforced", () => {
  const missing = validRegistry();
  missing.errors = missing.errors.filter((error) => error.code !== "internal");
  expectProblems(missing, /internal/);
  const retryable = validRegistry();
  retryable.errors.find((error) => error.code === "internal").retryable = true;
  expectProblems(retryable, /internal|retryable/);
  const status = validRegistry();
  status.errors.find((error) => error.code === "internal").http_status = 502;
  expectProblems(status, /internal|http_status/);
  const category = validRegistry();
  category.errors.find((error) => error.code === "internal").category =
    "unavailable";
  expectProblems(category, /internal|category/);
});

test("the Go renderer emits a standalone apierror package", () => {
  const registry = validRegistry();
  assert.match(renderGo(registry, ["internal"]), /package\s+apierror/);
});

test("renderers emit deterministic output", () => {
  const registry = validRegistry();
  const codes = ["widget_not_found", "version_conflict", "backend_down"];
  for (const [, render] of renderers)
    assert.equal(render(registry, codes), render(registry, codes));
});

test("renderers emit only requested codes plus the internal fallback", () => {
  const registry = validRegistry();
  for (const [name, render, constant] of renderers) {
    const output = render(registry, ["widget_not_found"]);
    for (const code of ["widget_not_found", "internal"])
      assert.match(
        output,
        new RegExp(`\\b${constant(code)}\\b`),
        `${name} emits ${code}`,
      );
    for (const code of [
      "widget_already_exists",
      "widget_precondition_failed",
      "backend_down",
      "unauthenticated",
      "unauthorized",
      "version_conflict",
      "conflict",
      "not_found",
    ])
      assert.doesNotMatch(
        output,
        new RegExp(`\\b${constant(code)}\\b`),
        `${name} omits ${code}`,
      );
  }
});

test("renderers always emit the canonical internal fallback", () => {
  const registry = validRegistry();
  assert.match(renderGo(registry, []), /\bInternal\b/);
  assert.match(renderTypeScript(registry, []), /\bINTERNAL\b/);
  assert.match(renderRust(registry, []), /\bINTERNAL\b/);
});

test("renderers reject codes missing from the registry", () => {
  const registry = validRegistry();
  for (const [, render] of renderers)
    assert.throws(() => render(registry, ["ghost_code"]));
});

test("renderers embed registry metadata with each constant", () => {
  const registry = validRegistry();
  for (const [name, render] of renderers) {
    const output = render(registry, ["widget_not_found", "backend_down"]);
    for (const fragment of [
      "widget_not_found",
      "not_found",
      "404",
      "backend_down",
      "unavailable",
      "503",
      "internal",
      "500",
    ])
      assert.ok(output.includes(fragment), `${name} renders ${fragment}`);
    assert.match(output, /retryable/i, `${name} renders retryable`);
    assert.match(output, /\btrue\b/);
    assert.match(output, /\bfalse\b/);
  }
});

test("alias constants keep their original wire value", () => {
  const registry = validRegistry();
  for (const [name, render, constant] of renderers) {
    const output = render(registry, ["version_conflict"]);
    assert.match(
      output,
      new RegExp(`\\b${constant("version_conflict")}\\b`),
      `${name} emits the alias constant`,
    );
    assert.ok(
      output.includes('"version_conflict"'),
      `${name} keeps the original wire value`,
    );
  }
});

test("rendered TypeScript metadata uses the formatter layout", () => {
  const registry = validRegistry();
  const output = renderTypeScript(registry, [
    "widget_not_found",
    "widget_precondition_failed",
  ]);
  assert.ok(
    output.includes(
      '  widget_not_found: { category: "not_found", httpStatus: 404, retryable: false },',
    ),
  );
  assert.ok(
    output.includes(
      '  widget_precondition_failed: {\n    category: "precondition_failed",\n    httpStatus: 412,\n    retryable: false,\n  },',
    ),
  );
  assert.ok(
    output.includes(
      "export function createError(code: string, message: string, requestId: string): ApiError {",
    ),
  );
});

function formatterOutput(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8" });
  if (result.error !== undefined) return undefined;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

function prettierBinary() {
  if (process.env.API_ERRORS_PRETTIER !== undefined)
    return process.env.API_ERRORS_PRETTIER;
  const candidate = fileURLToPath(
    new URL("services/agent-acp-service/node_modules/.bin/prettier", root),
  );
  return existsSync(candidate) ? candidate : undefined;
}

test("generated output is formatter-stable", (t) => {
  const registry = validRegistry();
  const checks = [
    {
      name: "gofmt",
      source: renderGo(registry, ["widget_not_found", "backend_down"]),
      format: (source) => formatterOutput("gofmt", [], source),
    },
    {
      name: "prettier",
      source: renderTypeScript(registry, [
        "widget_not_found",
        "widget_precondition_failed",
      ]),
      format: (source) => {
        const binary = prettierBinary();
        if (binary === undefined) return undefined;
        return formatterOutput(
          binary,
          [
            "--stdin-filepath",
            "errors.gen.ts",
            "--config",
            fileURLToPath(
              new URL("services/agent-acp-service/.prettierrc.json", root),
            ),
          ],
          source,
        );
      },
    },
    {
      name: "rustfmt",
      source: renderRust(registry, ["widget_not_found", "backend_down"]),
      format: (source) =>
        formatterOutput("rustfmt", ["--edition", "2024"], source),
    },
  ];
  const missing = [];
  for (const { name, source, format } of checks) {
    const formatted = format(source);
    if (formatted === undefined) missing.push(name);
    else
      assert.equal(
        formatted,
        source,
        `${name} would rewrite the generated source`,
      );
  }
  if (missing.length > 0) t.skip(`${missing.join(", ")} is unavailable`);
});

test("generated TypeScript falls back safely for hostile lookups", async () => {
  const registry = validRegistry();
  const source = renderTypeScript(registry, ["version_conflict"]);
  const stripped = stripTypeScriptTypes(source);
  const generated = await import(
    `data:text/javascript;base64,${Buffer.from(stripped).toString("base64")}`
  );
  for (const hostile of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "ghost_code",
  ]) {
    const error = generated.createError(hostile, "injected message", "req-1");
    assert.equal(error.code, "internal");
    assert.equal(error.category, "internal");
    assert.equal(error.message, "Internal service error");
    assert.equal(error.retryable, false);
    assert.equal(error.request_id, "req-1");
  }
  const regenerated = generated.createError(
    "ghost_code",
    "leaked",
    "not safe!!",
  );
  assert.equal(regenerated.message, "Internal service error");
  assert.match(regenerated.request_id, /^[A-Za-z0-9._:-]{1,128}$/);
  assert.notEqual(regenerated.request_id, "not safe!!");
  const alias = generated.createError(
    "version_conflict",
    "stale version",
    "req-2",
  );
  assert.equal(alias.code, "version_conflict");
  assert.equal(alias.category, "conflict");
  assert.equal(alias.message, "stale version");
  assert.equal(alias.retryable, false);
  assert.equal(alias.request_id, "req-2");
});

test("the generated Go request-id validator uses a positive allow branch", () => {
  const source = renderGo(validRegistry(), ["internal"]);
  const helper = source.match(/func validRequestID[\s\S]*?\n}/)?.[0];
  assert.ok(helper, "rendered Go includes validRequestID");
  assert.doesNotMatch(
    helper,
    /!\(/,
    "negated compound conditions trip staticcheck QF1001",
  );
  assert.match(
    helper,
    /\bcontinue\b/,
    "allowed bytes take a positive continue branch",
  );
  assert.ok(
    helper.includes(
      "if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-' {",
    ),
    "allowed byte ranges a-z A-Z 0-9 . _ : - are preserved",
  );
});

const API_ERROR_SERVICES = [
  "admin-console",
  "agent-acp-service",
  "agent-controller",
  "agent-ui",
  "antnest-runtime",
  "edge-gateway",
  "identity-service",
  "runtime-controller",
  "runtime-egress",
  "skill-registry",
];

test("the API error contract is sliced for all ten integrating services", () => {
  const slicesDir = new URL("contracts/common/slices/", root);
  const services = readdirSync(slicesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  assert.deepEqual(services.sort(), [...API_ERROR_SERVICES].sort());
});

test("the Agent UI slice covers every ACP producer code", () => {
  const ui = readJSON("contracts/common/slices/agent-ui.json");
  const acp = readJSON("contracts/common/slices/agent-acp-service.json");
  const missing = acp.codes.filter((code) => !ui.codes.includes(code));
  assert.deepEqual(missing, [], "UI slice must carry the full ACP vocabulary");
});

test("common error contract changes select exactly the ten integrating services", () => {
  for (const path of [
    "contracts/common/error.schema.json",
    "contracts/common/errors.json",
    "contracts/common/slices/agent-ui.json",
    "contracts/common/slices/agent-acp-service.json",
  ])
    assert.deepEqual(
      selectComponents([path]).sort(),
      [...API_ERROR_SERVICES].sort(),
      `${path} must select all ten integrating services`,
    );
});

function workflowEventPaths(text, event) {
  const section = text.match(
    new RegExp(`^  ${event}:[^\\n]*\\n((?: {4,}[^\\n]*\\n|\\n)*)`, "m"),
  );
  return (
    (section?.[1] ?? "").match(
      /^    paths:[ \t]*\n((?: {6}-[^\n]*(?:\n|$))+)/m,
    )?.[1] ?? ""
  );
}

test("every integrating service workflow watches contracts/common", () => {
  const separateEvents =
    "on:\n  push:\n    branches: [main]\n  pull_request:\n    paths:\n      - contracts/common/**\n";
  assert.equal(workflowEventPaths(separateEvents, "push"), "");
  assert.ok(
    workflowEventPaths(separateEvents, "pull_request").includes(
      "contracts/common/**",
    ),
  );
  for (const service of API_ERROR_SERVICES) {
    const workflow = service === "antnest-runtime" ? "runtime" : service;
    const path = `.github/workflows/${workflow}.yml`;
    const text = readFileSync(new URL(path, root), "utf8");
    for (const event of ["push", "pull_request"]) {
      const block = workflowEventPaths(text, event);
      assert.ok(
        block.includes("contracts/common/**"),
        `${path}: ${event} paths must include contracts/common/**`,
      );
    }
  }
});
