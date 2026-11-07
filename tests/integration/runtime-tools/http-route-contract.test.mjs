import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  routeBodyProblems,
  routeParityProblems,
} from "../../support/contracts/route-parity.mjs";
import { loadGolden } from "../../support/contracts/golden.mjs";

const runtimeDir = new URL("../../../contracts/runtime/", import.meta.url);
const mcpSource = readFileSync(
  new URL("../../../runtimes/antnest-runtime/src/mcp.rs", import.meta.url),
  "utf8",
);
const temporarySource = readFileSync(
  new URL(
    "../../../runtimes/antnest-runtime/src/skill_temporary_http.rs",
    import.meta.url,
  ),
  "utf8",
);
const errorSource = readFileSync(
  new URL(
    "../../../runtimes/antnest-runtime/src/api_errors_gen.rs",
    import.meta.url,
  ),
  "utf8",
);
const contract = JSON.parse(
  readFileSync(new URL("contract.json", runtimeDir), "utf8"),
);
const callers = JSON.parse(
  readFileSync(new URL("callers.json", runtimeDir), "utf8"),
);

const SCHEMA_FILES = [
  [
    new URL("../../../contracts/runtime/", import.meta.url),
    "temporary-skills.schema.json",
  ],
  [
    new URL("../../../contracts/runtime/", import.meta.url),
    "skill-maintenance.schema.json",
  ],
  [new URL("../../../contracts/runtime/", import.meta.url), "http.schema.json"],
  [
    new URL("../../../contracts/runtime/", import.meta.url),
    "runtime-status.schema.json",
  ],
  [new URL("../../../contracts/common/", import.meta.url), "error.schema.json"],
];

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");

function localValidator() {
  const ajv = new Ajv2020({ formats: { "date-time": true, uri: true } });
  for (const [dir, name] of SCHEMA_FILES)
    ajv.addSchema(JSON.parse(readFileSync(new URL(name, dir), "utf8")));
  return ajv;
}
const ajv = localValidator();
const BASE = "https://schemas.antnest.dev/";
const absolute = (reference) => {
  const [file, fragment] = reference.split("#", 2);
  const parts = [];
  for (const part of `runtime/${file}`.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return `${BASE}${parts.join("/")}${fragment ? `#${fragment}` : ""}`;
};
const validate = (reference, document) => {
  const validator = ajv.getSchema(absolute(reference));
  assert(validator !== undefined, `unresolvable schema ${reference}`);
  assert.equal(
    validator(document),
    true,
    `${reference}: ${ajv.errorsText?.(validator.errors) ?? JSON.stringify(validator.errors)}`,
  );
};

const REPRESENTATIVE = {
  "runtime-status.schema.json": () => ({
    agent_id: "agent-1",
    generation: 2,
    execution_id: "execution-1",
    status: "ready",
    test_features: [],
  }),
  "http.schema.json#/$defs/live_status": () => ({ status: "ready" }),
  "http.schema.json#/$defs/protocol_request": () => ({
    jsonrpc: "2.0",
    method: "initialize",
    params: {},
    id: 1,
  }),
  "http.schema.json#/$defs/protocol_message": () => ({
    jsonrpc: "2.0",
    id: 1,
    result: {},
  }),
  "http.schema.json#/$defs/protocol_response": () => ({
    jsonrpc: "2.0",
    id: 1,
    result: {},
  }),
  "skill-maintenance.schema.json": () => ({
    request_id: "request-1",
    action: "digest",
    execution_id: "execution-1",
    outcome: "observed",
    observed_digest: `sha256:${"a".repeat(64)}`,
  }),
  "skill-maintenance.schema.json#/$defs/digest_request": () => ({
    action: "digest",
    request_id: "request-1",
    job_id: "job-1",
    generation: 1,
    package_path: ".antnest/skills/example",
  }),
  "skill-maintenance.schema.json#/$defs/maintenance_receipt": () => ({
    request_id: "request-1",
    action: "install",
    execution_id: "execution-1",
    outcome: "applied",
    observed_digest: `sha256:${"a".repeat(64)}`,
  }),
  "skill-maintenance.schema.json#/$defs/install_request": () => ({
    action: "install",
    request_id: "request-1",
    job_id: "job-1",
    generation: 1,
    package_path: ".antnest/skills/example",
    expected_base_digest: `sha256:${"a".repeat(64)}`,
    target_digest: `sha256:${"a".repeat(64)}`,
    artifact_digest: `sha256:${"a".repeat(64)}`,
    package_rules_version: 1,
  }),
  "temporary-skills.schema.json": () =>
    loadGolden("runtime", "temporary-install.installed.json"),
  "temporary-skills.schema.json#/$defs/install_metadata": () => ({
    action: "temporary_install",
    request_id: "request-1",
    job_id: "run-1",
    generation: 1,
    content_digest: `sha256:${"a".repeat(64)}`,
    artifact_digest: `sha256:${"b".repeat(64)}`,
    package_rules_version: 1,
  }),
  "temporary-skills.schema.json#/$defs/release_request": () => ({
    action: "temporary_release",
    request_id: "request-1",
    job_id: "run-1",
    generation: 1,
  }),
  "temporary-skills.schema.json#/$defs/install_reply": () =>
    loadGolden("runtime", "temporary-install.installed.json"),
  "temporary-skills.schema.json#/$defs/release_reply": () =>
    loadGolden("runtime", "temporary-release.released.json"),
  "temporary-skills.schema.json#/$defs/error_reply": () =>
    loadGolden("runtime", "temporary-operation.disabled.json"),
  "../common/error.schema.json": () => ({
    code: "runtime_unauthorized",
    category: "unauthenticated",
    message: "Runtime request rejected",
    retryable: false,
    request_id: "request-1",
  }),
};

const routeLabel = (route) => `${route.method} ${route.path}`;

const ROUTE_CONSTANT = /\bconst ([A-Z_]+): &str = "([^"]+)"/g;
const EVERY_HOOK = /\.(route|nest_service|merge)\(/g;
const HTTP_ROUTES_LIST = /HTTP_ROUTES: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "head"]);

function callArguments(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length && depth > 0) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") depth -= 1;
    index += 1;
  }
  return { args: source.slice(start, index - 1), end: index };
}

function firstArgument(args) {
  let depth = 0;
  for (let index = 0; index < args.length; index += 1) {
    const ch = args[index];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) return args.slice(0, index).trim();
  }
  return args.trim();
}

function methodsAtDepthZero(text) {
  const names = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0) {
      const call = /^([a-z_]+)\(/.exec(text.slice(index));
      if (call) {
        names.push(call[1]);
        index += call[1].length;
        continue;
      }
    }
    index += 1;
  }
  return names;
}

function sourceRoutes(mcp = mcpSource, temporary = temporarySource) {
  const constants = new Map();
  for (const source of [mcp, temporary])
    for (const match of source.matchAll(ROUTE_CONSTANT))
      constants.set(match[1], match[2]);
  const resolve = (expression) => {
    if (expression.startsWith('"')) return JSON.parse(expression);
    return constants.get(expression.split("::").pop());
  };
  const problems = [];
  const registered = [];
  for (const source of [mcp, temporary]) {
    for (const match of source.matchAll(EVERY_HOOK)) {
      const { args } = callArguments(source, match.index + match[0].length);
      const kind = match[1];
      if (kind === "merge") {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(firstArgument(args)))
          problems.push(`unsupported .merge( target ${firstArgument(args)}`);
        continue;
      }
      const path = resolve(firstArgument(args));
      if (path === undefined) {
        problems.push(`unresolved ${kind} path ${firstArgument(args)}`);
        continue;
      }
      if (kind === "nest_service") {
        registered.push(`* ${path}`, `* ${path}/{path...}`);
        continue;
      }
      const methods = methodsAtDepthZero(
        args.slice(args.indexOf(",") + 1),
      ).filter((name) => HTTP_METHODS.has(name));
      if (methods.length === 0) {
        problems.push(`unparsed method chain for ${path}`);
        continue;
      }
      for (const method of methods)
        registered.push(`${method.toUpperCase()} ${path}`);
    }
  }
  const inventory = mcp.match(HTTP_ROUTES_LIST);
  assert(inventory !== null, "HTTP_ROUTES inventory missing");
  const listed = [];
  for (const entry of inventory[1].matchAll(
    /\("([^"]+)",\s*("[^"]+"|[A-Z_]+|[A-Za-z_:]+)\)/g,
  ))
    listed.push(`${entry[1]} ${resolve(entry[2])}`);
  return { registered: registered.sort(), listed: listed.sort(), problems };
}

function declaredRoutes() {
  return contract.routes.map(routeLabel).sort();
}

function catalogRoutes(catalog) {
  return Object.keys(catalog.routes).sort();
}

test("runtime contract declares the complete seven-route HTTP surface", () => {
  assert.deepEqual(routeBodyProblems(contract.routes), []);
  assert(!("trusted_internal_hosts" in contract.transport));
  assert.equal(
    contract.transport.host_policy,
    "owned-alias-and-loopback-with-exact-port",
  );
  assert.equal(
    contract.transport.instance_connection_contract,
    "instance-connection-contract.json",
  );
  assert.deepEqual(
    declaredRoutes(),
    [
      "* /mcp",
      "* /mcp/{path...}",
      "GET /status",
      "GET /status/live",
      "HEAD /status/live",
      "POST /internal/skill-maintenance/{action}",
      "POST /internal/skill-temporary/{action}",
    ].sort(),
  );
});

test("every declared body reference resolves to a published runtime schema", () => {
  const bodies = new Set();
  const collect = (reference) => {
    if (typeof reference === "string" && reference !== "none")
      bodies.add(reference);
  };
  for (const route of contract.routes) {
    collect(route.request_body);
    for (const entry of Object.values(route.responses)) collect(entry.body);
    for (const action of Object.values(route.actions ?? {})) {
      collect(action.request_body);
      if (action.response_body !== undefined) collect(action.response_body);
    }
    for (const method of Object.values(route.protocol_methods ?? {})) {
      collect(method.request_body);
      collect(method.response_body);
    }
  }
  for (const body of bodies) {
    const document = REPRESENTATIVE[body]?.();
    assert(document !== undefined, `no representative document for ${body}`);
    validate(body, document);
  }
  validate(
    "../common/error.schema.json",
    REPRESENTATIVE["../common/error.schema.json"](),
  );
});

test("contract routes match the caller catalog, HTTP_ROUTES and registered routes", () => {
  assert.deepEqual(
    routeParityProblems(declaredRoutes(), catalogRoutes(callers)),
    [],
  );
  const { registered, listed, problems } = sourceRoutes();
  assert.deepEqual(problems, []);
  assert.deepEqual(listed, declaredRoutes());
  const expected = listed.filter((route) => route !== "HEAD /status/live");
  assert.deepEqual(registered, expected);
});

test("added served or unsupported registrations fail the parity gate", () => {
  for (const snippet of [
    `.route("/internal/extra", get(extra_handler))`,
    `const EXTRA_ROUTE: &str = "/internal/extra";\n.route(EXTRA_ROUTE, get(extra_handler))`,
    `.nest_service("/extra", extra_service)`,
  ]) {
    const { registered } = sourceRoutes(mcpSource + snippet);
    assert.notDeepEqual(
      routeParityProblems(
        declaredRoutes(),
        registered.concat("HEAD /status/live"),
      ),
      [],
      snippet,
    );
  }
  const { problems } = sourceRoutes(`${mcpSource}.route(other, handler)`);
  assert.notDeepEqual(problems, []);
});

test("live liveness is anonymous health; every other route is workload authority", () => {
  for (const route of contract.routes) {
    const live = route.path === "/status/live";
    assert.equal(
      route.authentication,
      live ? "health" : "workload",
      routeLabel(route),
    );
    const codes = route.errors.map((error) => error.code);
    assert.equal(
      codes.includes("runtime_unauthorized"),
      !live,
      `${routeLabel(route)} workload auth`,
    );
    if (route.path.startsWith("/internal/"))
      assert(
        route.signed_authority === "maintenance_ticket",
        `${routeLabel(route)} missing signed ticket declaration`,
      );
  }
});

test("every declared error is a generated runtime code with a real status", () => {
  const codes = new Set();
  for (const match of errorSource.matchAll(
    /pub const [A-Z_]+: &str = "([^"]+)"/g,
  ))
    codes.add(match[1]);
  for (const route of contract.routes) {
    assert.equal(route.error_schema, "../common/error.schema.json");
    for (const error of route.errors) {
      assert(codes.has(error.code), `${routeLabel(route)} ${error.code}`);
      assert(
        Number.isInteger(error.status) &&
          error.status >= 100 &&
          error.status <= 599,
        `${routeLabel(route)} ${JSON.stringify(error)}`,
      );
    }
  }
});

test("the MCP mounts distinguish per-method bodies and keep the execution fence", () => {
  for (const route of contract.routes.filter((route) =>
    route.path.startsWith("/mcp"),
  )) {
    assert.equal(
      route.request_body,
      "http.schema.json#/$defs/protocol_request",
    );
    const methods = route.protocol_methods;
    assert.equal(
      methods?.POST?.request_body,
      "http.schema.json#/$defs/protocol_request",
    );
    assert.equal(
      methods?.POST?.response_body,
      "http.schema.json#/$defs/protocol_response",
    );
    assert.deepEqual(methods?.POST?.response_content_types, [
      "application/json",
      "text/event-stream",
    ]);
    assert.equal(methods?.GET?.request_body, "none");
    assert.equal(
      methods?.GET?.response_body,
      "http.schema.json#/$defs/protocol_message",
    );
    assert.deepEqual(methods?.GET?.response_content_types, [
      "text/event-stream",
    ]);
    assert.equal(methods?.DELETE?.request_body, "none");
    if (route.path === "/mcp")
      assert.equal(route.execution_fence, "X-Antnest-Expected-Execution-ID");
    else assert(!("execution_fence" in route), `${routeLabel(route)} fence`);
  }
});

test("skill maintenance and temporary routes declare per-action bodies", () => {
  const maintenance = contract.routes.find(
    (route) => route.path === "/internal/skill-maintenance/{action}",
  );
  assert.equal(
    maintenance.actions.digest.request_body,
    "skill-maintenance.schema.json#/$defs/digest_request",
  );
  assert.equal(
    maintenance.actions.install.request_body,
    "skill-maintenance.schema.json#/$defs/install_request",
  );
  assert.equal(maintenance.actions.install.content_type, "multipart/form-data");
  const temporary = contract.routes.find(
    (route) => route.path === "/internal/skill-temporary/{action}",
  );
  assert.equal(
    temporary.actions.install.request_body,
    "temporary-skills.schema.json#/$defs/install_metadata",
  );
  assert.equal(
    temporary.actions.release.request_body,
    "temporary-skills.schema.json#/$defs/release_request",
  );
});
