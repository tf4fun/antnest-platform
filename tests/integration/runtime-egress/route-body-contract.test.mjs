import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  routeBodyProblems,
  routeParityProblems,
} from "../../support/contracts/route-parity.mjs";
import { loadGolden, validateGolden } from "../../support/contracts/golden.mjs";

const egressDir = new URL("../../../contracts/egress/", import.meta.url);
const controlSource = readFileSync(
  new URL("../../../services/runtime-egress/src/control.rs", import.meta.url),
  "utf8",
);
const contract = JSON.parse(
  readFileSync(new URL("control-contract.json", egressDir), "utf8"),
);
const callers = JSON.parse(
  readFileSync(new URL("callers.json", egressDir), "utf8"),
);

const routeLabel = (route) => `${route.method} ${route.path}`;

const schemaRef = (body) =>
  body.startsWith("../") ? body.slice(3) : `egress/${body}`;

const REPRESENTATIVE = {
  "control-response.schema.json#/$defs/status": () => ({
    status: "ready",
    data_plane_ready: true,
    control_plane_ready: true,
    snapshot_revision: 1,
  }),
  "control-response.schema.json#/$defs/network": () =>
    loadGolden("egress", "network.open.json"),
  "control-response.schema.json#/$defs/policy_revision": () =>
    loadGolden("egress", "policy.v1.json"),
  "control-response.schema.json#/$defs/policy_metadata": () =>
    loadGolden("egress", "policy-metadata.v1.json"),
  "control-response.schema.json#/$defs/assignment": () =>
    loadGolden("egress", "assignment.current.json"),
  "policy-revision-request.schema.json": () => ({
    spec: { schema_version: 1, action: "allow_all" },
  }),
  "policy-assignment-request.schema.json": () => ({
    policy_id: "builtin/allow-all",
    revision: 1,
    expected_version: "1",
  }),
  "tunnel-key-request.schema.json": () => ({
    key_id: `rtk_${"0".repeat(32)}`,
    runtime_revision: `rtv_${"0".repeat(32)}`,
    tunnel_ipv4: "100.64.0.2",
    egress_private_key: "A".repeat(43),
    runtime_public_key: "A".repeat(43),
    preshared_key: "A".repeat(43),
  }),
  "attachment-state-request.schema.json": () => ({
    state: "closed",
    expected_version: "1",
  }),
  "attachment-state-body.schema.json": () => ({ state: "closed" }),
  "resource-version-request.schema.json": () => ({ expected_version: "1" }),
  "resource-version-body.schema.json": () => ({}),
  "../common/error.schema.json": () => ({
    code: "route_not_found",
    category: "not_found",
    message: "route was not found",
    retryable: false,
    request_id: "request-1",
  }),
};

function declaredRoutes() {
  return contract.routes.map(routeLabel).sort();
}

function catalogRoutes(catalog) {
  return Object.entries(catalog.routes)
    .filter(
      ([route, policy]) =>
        !route.includes("*") && policy.authentication !== "deny",
    )
    .map(([route]) => route)
    .sort();
}

const ROUTE_CONSTANT = /\bconst ([A-Z_]+): &str = "([^"]+)"/g;
const EVERY_ROUTE = /\.route\(/g;
const ROUTE_REGISTRATION =
  /\.route\(\s*("[^"]+"|[A-Z_]+)\s*,\s*((?:(?:get|put|post|delete|head)\([^)]*\)\s*\.?)+)\s*,?\s*\)/g;
const CONTROL_ROUTES_LIST =
  /CONTROL_ROUTES: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/;

function sourceRoutes(source = controlSource) {
  const constants = new Map();
  for (const match of source.matchAll(ROUTE_CONSTANT))
    constants.set(match[1], match[2]);
  const problems = [];
  const resolve = (expression) => {
    if (expression.startsWith('"')) return JSON.parse(expression);
    return constants.get(expression);
  };
  const registered = [];
  let unsupported = 0;
  for (const _ of source.matchAll(EVERY_ROUTE)) unsupported += 1;
  for (const match of source.matchAll(ROUTE_REGISTRATION)) {
    const path = resolve(match[1]);
    if (path === undefined) {
      problems.push(`unresolved route path ${match[1]}`);
      continue;
    }
    unsupported -= 1;
    for (const method of match[2].matchAll(/(get|put|post|delete|head)\(/g))
      registered.push(`${method[1].toUpperCase()} ${path}`);
  }
  if (unsupported !== 0)
    problems.push(
      `${unsupported} .route( registrations use unsupported syntax`,
    );
  const inventory = source.match(CONTROL_ROUTES_LIST);
  assert(inventory !== null, "CONTROL_ROUTES inventory missing");
  const listed = [];
  for (const entry of inventory[1].matchAll(
    /\("([A-Z]+)",\s*("[^"]+"|[A-Z_]+)\)/g,
  ))
    listed.push(`${entry[1]} ${resolve(entry[2])}`);
  return { registered: registered.sort(), listed: listed.sort(), problems };
}

test("control contract declares a complete body contract for every route", () => {
  assert.equal(contract.revision, 9);
  assert.deepEqual(routeBodyProblems(contract.routes), []);
});

test("every declared request and response body resolves against the published schemas", async () => {
  const bodies = new Set();
  for (const route of contract.routes) {
    assert.equal(typeof route.request_body, "string", routeLabel(route));
    if (route.request_body !== "none") bodies.add(route.request_body);
    for (const entry of Object.values(route.responses))
      if (entry.body !== "none") bodies.add(entry.body);
  }
  for (const body of bodies) {
    const file = body.split("#", 1)[0];
    JSON.parse(readFileSync(new URL(file, egressDir), "utf8"));
    const document = REPRESENTATIVE[body]?.();
    assert(document !== undefined, `no representative document for ${body}`);
    assert.equal(await validateGolden(schemaRef(body), document), true, body);
  }
});

test("every declared error code is a published control error with a real status", () => {
  const codes = new Set(contract.error_codes);
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
  for (const error of contract.fallback_errors ?? []) {
    assert(codes.has(error.code), `fallback ${error.code}`);
    assert(Number.isInteger(error.status), JSON.stringify(error));
  }
});

test("contract routes match the caller catalog and the served router in both directions", () => {
  assert.deepEqual(
    routeParityProblems(declaredRoutes(), catalogRoutes(callers)),
    [],
  );
  const { registered, listed, problems } = sourceRoutes();
  assert.deepEqual(problems, []);
  assert.deepEqual(listed, declaredRoutes());
  assert.deepEqual(registered, declaredRoutes());
});

test("source extraction fails closed on literal and unsupported routes", () => {
  for (const snippet of [
    `.route("/internal/extra", get(extra_handler))`,
    `const EXTRA_ROUTE: &str = "/internal/extra";\n.route(EXTRA_ROUTE, get(extra_handler))`,
    `const EXTRA_ROUTE: &str = "/internal/extra";\n.route(EXTRA_ROUTE, get(extra_handler).post(extra_handler))`,
  ]) {
    const { registered } = sourceRoutes(controlSource + snippet);
    assert.notDeepEqual(
      routeParityProblems(declaredRoutes(), registered),
      [],
      snippet,
    );
  }
  const { problems } = sourceRoutes(`${controlSource}.route(other, handler)`);
  assert.notDeepEqual(problems, []);
});

test("an undeclared served route or a missing body contract fails the metadata checks", () => {
  assert.notDeepEqual(
    routeParityProblems(declaredRoutes(), [
      ...catalogRoutes(callers),
      "DELETE /internal/agent-networks/{agent_id}",
    ]),
    [],
  );
  assert.notDeepEqual(
    routeParityProblems(
      [...declaredRoutes(), "DELETE /internal/agent-networks/{agent_id}"],
      catalogRoutes(callers),
    ),
    [],
  );
  const noBody = structuredClone(contract.routes);
  delete noBody[0].request_body;
  delete noBody[0].request_schema;
  assert.notDeepEqual(routeBodyProblems(noBody), []);
  const legacyOnly = structuredClone(contract.routes);
  delete legacyOnly[0].request_body;
  assert.deepEqual(routeBodyProblems(legacyOnly), []);
  const noResponses = structuredClone(contract.routes);
  delete noResponses[0].responses;
  assert.notDeepEqual(routeBodyProblems(noResponses), []);
});

test("status is a local health probe outside workload admission", () => {
  const status = contract.routes.find((route) => route.path === "/status");
  assert.equal(status.method, "GET");
  assert.equal(status.authentication, "health");
  assert.equal(status.request_body, "none");
  for (const error of status.errors)
    assert(
      !["service_unauthenticated", "caller_not_allowed"].includes(error.code),
      `status declares workload error ${error.code}`,
    );
  const catalogStatus = callers.routes["GET /status"];
  assert.equal(catalogStatus.authentication, "health");
  assert.deepEqual(catalogStatus.callers, ["local-healthcheck"]);
});

test("tunnel key registration is runtime-controller only and never captured", () => {
  const route = contract.routes.find(
    (route) => route.path === "/internal/agent-tunnel-keys/{agent_id}",
  );
  assert.equal(route.caller, "runtime-controller");
  assert.equal(route.content_capture, "never");
  assert.equal(route.request_body, "tunnel-key-request.schema.json");
  assert.equal(route.responses["204"].body, "none");
  assert.equal(
    callers.routes["PUT /internal/agent-tunnel-keys/{agent_id}"].request_body,
    "json",
  );
});

test("JSON-carrier routes are exactly the five strict request bodies", () => {
  const jsonRoutes = contract.routes
    .filter((route) => route.request_body !== "none")
    .map(routeLabel)
    .sort();
  assert.deepEqual(jsonRoutes, [
    "POST /internal/agent-networks/{agent_id}/release",
    "PUT /internal/agent-network-attachments/{agent_id}",
    "PUT /internal/agent-policy-assignments/{agent_id}",
    "PUT /internal/agent-tunnel-keys/{agent_id}",
    "PUT /internal/policies/{policy_id}/revisions/{revision}",
  ]);
  for (const route of contract.routes) {
    const json = route.request_body !== "none";
    const codes = route.errors.map((error) => error.code);
    assert.equal(
      codes.includes("unsupported_media_type"),
      json,
      `${routeLabel(route)} media type rule`,
    );
  }
});
