import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectSources,
  discoverRoutes,
} from "../check-service-authentication.mjs";
import { loadContracts } from "../../../scripts/check-contract-conventions.mjs";
import { collectContractRoutes } from "./route-parity.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const contractsRoot = new URL("contracts/", repoRoot);
const repoPath = (relative) => fileURLToPath(new URL(relative, repoRoot));
const readContract = (relative) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, contractsRoot)), "utf8"),
  );
const readContractIfPresent = (relative) => {
  const path = fileURLToPath(new URL(relative, contractsRoot));
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};

const activeContract = readContract("admin-console/admin-contract.json");
const adminProposal = readContract(
  "admin-console/directory-publication-proposal.json",
);
const contract =
  activeContract.version === adminProposal.base_version
    ? { ...activeContract, ...adminProposal.catalog_patch }
    : activeContract;
const callers = readContract("admin-console/callers.json");
const slice = readContract("common/slices/admin-console.json");
const registry = readContract("common/errors.json");
const activeIdentity = readContract("identity/identity-contract.json");
const identityProposal = readContract(
  "identity/directory-publication-proposal.json",
);
const identity =
  activeIdentity.revision === identityProposal.base_revision
    ? {
        ...activeIdentity,
        revision: identityProposal.target_revision,
        methods: { ...activeIdentity.methods, ...identityProposal.methods },
      }
    : activeIdentity;
const adminSchema = readContractIfPresent(
  "admin-console/admin-api.schema.json",
);
const directorySchema = readContractIfPresent("identity/directory.schema.json");
const errorsView = readContractIfPresent("admin-console/errors.json");
const goErrors = readFileSync(
  repoPath("services/admin-console/internal/apierror/errors.gen.go"),
  "utf8",
);
const tsErrors = readFileSync(
  repoPath("services/admin-console/web/src/lib/errors.gen.ts"),
  "utf8",
);

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const CANONICAL = "https://schemas.antnest.dev/";
const adminDef = (name) =>
  `${CANONICAL}admin-console/admin-api.schema.json#/$defs/${name}`;
const identityDef = (name) =>
  `${CANONICAL}identity/directory.schema.json#/$defs/${name}`;

const schemaRegistry = (async () => {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: false,
  });
  const documents = await loadContracts(contractsRoot);
  for (const [key, document] of documents) {
    if (!isObject(document)) continue;
    if (!key.endsWith(".schema.json") && !("$schema" in document)) continue;
    if (typeof document.$id !== "string") continue;
    ajv.addSchema(document);
  }
  return ajv;
})();

async function compile(absoluteRef) {
  const ajv = await schemaRegistry;
  const validate = ajv.getSchema(absoluteRef);
  assert.ok(validate !== undefined, `unresolvable schema ${absoluteRef}`);
  return validate;
}

const sortedKeys = (value) => Object.keys(value ?? {}).sort();
const sorted = (value) => [...value].sort();

const SCHEMA_FILE = "admin-api.schema.json";
const requestRef = (name) => `${SCHEMA_FILE}#/$defs/${name}_request`;
const responseRef = (name) => `${SCHEMA_FILE}#/$defs/${name}_response`;
const REQUEST_KINDS = ["none", "json", "multipart"];
const RESPONSE_KINDS = ["none", "json", "binary", "event_stream"];

function routeMetadataProblems(name, route) {
  const problems = [];
  const label = `route ${name}`;
  if (!isObject(route)) return [`${label}: route entry must be an object`];
  const requestSchema = requestRef(name);
  const responseSchema = responseRef(name);
  if (route.request_schema !== requestSchema)
    problems.push(`${label}: request_schema must be ${requestSchema}`);
  if (route.response_schema !== responseSchema)
    problems.push(`${label}: response_schema must be ${responseSchema}`);
  const requestBody = route.request_body;
  if (!isObject(requestBody) || !REQUEST_KINDS.includes(requestBody.kind)) {
    problems.push(
      `${label}: request_body must declare kind none, json or multipart`,
    );
  } else {
    const allowed =
      requestBody.kind === "none"
        ? ["kind", "input"]
        : requestBody.kind === "json"
          ? ["kind", "schema"]
          : ["kind", "content_type", "schema"];
    for (const key of Object.keys(requestBody))
      if (!allowed.includes(key))
        problems.push(`${label}: unexpected request_body.${key}`);
    if (requestBody.kind === "none") {
      if (requestBody.input !== "query_and_path")
        problems.push(
          `${label}: bodyless request_body must declare input query_and_path`,
        );
    } else {
      if (requestBody.schema !== requestSchema)
        problems.push(`${label}: request_body.schema must be ${requestSchema}`);
      if (
        requestBody.kind === "multipart" &&
        requestBody.content_type !== "multipart/form-data"
      )
        problems.push(
          `${label}: multipart request_body must declare content_type multipart/form-data`,
        );
    }
  }
  const responseBody = route.response_body;
  if (!isObject(responseBody) || !RESPONSE_KINDS.includes(responseBody.kind)) {
    problems.push(
      `${label}: response_body must declare kind none, json, binary or event_stream`,
    );
  } else {
    const allowed =
      responseBody.kind === "none"
        ? ["kind"]
        : responseBody.kind === "json"
          ? ["kind", "schema"]
          : responseBody.kind === "binary"
            ? ["kind", "content_type"]
            : ["kind", "content_type", "event", "event_id", "data"];
    for (const key of Object.keys(responseBody))
      if (!allowed.includes(key))
        problems.push(`${label}: unexpected response_body.${key}`);
    if (responseBody.kind === "json" && responseBody.schema !== responseSchema)
      problems.push(`${label}: response_body.schema must be ${responseSchema}`);
    if (
      responseBody.kind === "binary" &&
      responseBody.content_type !== "application/zip"
    )
      problems.push(
        `${label}: binary response_body must declare content_type application/zip`,
      );
    if (responseBody.kind === "event_stream") {
      if (responseBody.content_type !== "text/event-stream")
        problems.push(
          `${label}: event_stream response_body must declare content_type text/event-stream`,
        );
      if (responseBody.data !== responseSchema)
        problems.push(`${label}: response_body.data must be ${responseSchema}`);
      for (const key of ["event", "event_id"])
        if (typeof responseBody[key] !== "string" || responseBody[key] === "")
          problems.push(`${label}: event_stream response_body needs ${key}`);
    }
  }
  return problems;
}

function metadataProblems(routes) {
  const problems = [];
  for (const [name, route] of Object.entries(routes ?? {}))
    problems.push(...routeMetadataProblems(name, route));
  return problems.sort();
}

function definitionProblems(definition, kind, label) {
  if (
    definition === true ||
    definition === undefined ||
    definition === null ||
    (isObject(definition) && Object.keys(definition).length === 0)
  )
    return [`${label}: ${kind} definition must not be an empty placeholder`];
  if (!isObject(definition))
    return [`${label}: ${kind} definition must be a schema object`];
  if (typeof definition.$ref === "string") return [];
  if (
    kind === "response" &&
    definition.type === "string" &&
    definition.contentMediaType === "application/zip"
  )
    return [];
  if (definition.type !== "object" || definition.additionalProperties !== false)
    return [`${label}: ${kind} definition must be a closed object`];
  if (
    kind === "response" &&
    Object.keys(definition.properties ?? {}).length === 0
  )
    return [`${label}: response definition must declare envelope properties`];
  return [];
}

function expectedRequestProperties(route) {
  const names = new Set();
  for (const match of route.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
    names.add(match[1]);
  if (isObject(route.query))
    for (const key of ["required", "optional", "deprecated"])
      for (const name of route.query[key] ?? []) names.add(name);
  return names;
}

function expectedRequiredProperties(route) {
  const names = new Set();
  for (const match of route.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
    names.add(match[1]);
  if (isObject(route.query))
    for (const name of route.query.required ?? []) names.add(name);
  return names;
}

function resolveLocalDef(document, node, depth = 4) {
  let current = node;
  while (
    depth > 0 &&
    isObject(current) &&
    typeof current.$ref === "string" &&
    current.$ref.startsWith("#/$defs/")
  ) {
    current = document.$defs?.[current.$ref.slice("#/$defs/".length)];
    depth -= 1;
  }
  return current;
}

function errorsViewProblems(view, sliceCodes, registryByCode) {
  const problems = [];
  if (!isObject(view)) return ["view must be an object"];
  for (const key of Object.keys(view))
    if (!["service", "source", "errors"].includes(key))
      problems.push(`view must not declare ${key}`);
  if (view.service !== "admin-console")
    problems.push("view service must be admin-console");
  if (view.source !== "../common/errors.json")
    problems.push("view source must be ../common/errors.json");
  const errors = view.errors;
  if (!Array.isArray(errors)) {
    problems.push("view errors must be an array");
  } else {
    const codes = errors.map((entry) => (isObject(entry) ? entry.code : entry));
    if (JSON.stringify(codes) !== JSON.stringify(sliceCodes))
      problems.push("view errors must list exactly the slice codes in order");
    errors.forEach((entry, index) => {
      if (!isObject(entry)) {
        problems.push(`view error ${index} must be an object`);
        return;
      }
      const keys = sortedKeys(entry);
      if (
        JSON.stringify(keys) !==
        JSON.stringify(["code", "description", "retryable", "status"])
      )
        problems.push(
          `view error ${entry.code ?? index} must declare exactly code, status, retryable and description`,
        );
      const documented = registryByCode.get(entry.code);
      if (documented === undefined) {
        problems.push(`view error ${entry.code} is not a registry code`);
        return;
      }
      if (entry.status !== documented.http_status)
        problems.push(
          `view error ${entry.code} status must be the registry ${documented.http_status}`,
        );
      if (entry.retryable !== documented.retryable)
        problems.push(
          `view error ${entry.code} retryable must be the registry ${documented.retryable}`,
        );
      if (entry.description !== documented.description)
        problems.push(
          `view error ${entry.code} description must be the registry description`,
        );
    });
  }
  return problems.sort();
}

const registryByCode = new Map(
  registry.errors.map((entry) => [entry.code, entry]),
);

const ROUTE_COUNT = 71;
const PLANNED_UNREGISTERED = [
  "GET /api/admin/directory/groups",
  "GET /api/admin/directory/members",
];

const timestamp = "2026-11-01T00:00:00Z";
const directoryUser = {
  id: "user-1",
  system_role: "user",
  active: true,
  created_at: timestamp,
  updated_at: timestamp,
};
const directoryMembership = {
  id: "membership-1",
  user_id: "user-1",
  email: "member@example.com",
  display_name: "Member",
  role: "member",
  source: "local",
  active: true,
  created_at: timestamp,
  updated_at: timestamp,
};
const directoryMember = {
  user: directoryUser,
  membership: directoryMembership,
};
const directoryGroup = {
  display_name: "Operators",
  source: "local",
  active: true,
  created_at: timestamp,
  updated_at: timestamp,
};
const internalMembership = {
  organization_id: "org-1",
  ...directoryMembership,
};
const internalGroup = {
  id: "group-1",
  organization_id: "org-1",
  ...directoryGroup,
};

test("catalog version 61 declares paginated directory routes and lifecycle holds", () => {
  assert.equal(contract.version, 61);
  assert.equal(contract.base_path, "/api/admin");
  assert.equal(Object.keys(contract.routes).length, ROUTE_COUNT);
  const members = contract.routes.directory_members;
  assert.deepEqual(
    { method: members?.method, path: members?.path },
    { method: "GET", path: "/directory/members" },
  );
  assert.deepEqual(sorted(members?.query?.optional ?? []), [
    "active",
    "cursor",
    "limit",
    "q",
    "role",
    "source",
  ]);
  assert.equal(members?.query?.cursor_response, "next_cursor");
  assert.ok(!("deprecated" in (members?.query ?? {})));
  const groups = contract.routes.directory_groups;
  assert.deepEqual(
    { method: groups?.method, path: groups?.path },
    { method: "GET", path: "/directory/groups" },
  );
  assert.deepEqual(sorted(groups?.query?.optional ?? []), [
    "active",
    "cursor",
    "limit",
    "q",
    "source",
  ]);
  assert.equal(groups?.query?.cursor_response, "next_cursor");
  assert.ok(!("deprecated" in (groups?.query ?? {})));
  for (const [name, method, path] of [
    [
      "cancel_lifecycle_operation",
      "POST",
      "/agents/{agent_id}/lifecycle-operation/cancel",
    ],
    [
      "clear_lifecycle_quarantine",
      "POST",
      "/agents/{agent_id}/lifecycle-quarantine/clear",
    ],
  ]) {
    assert.deepEqual(
      {
        method: contract.routes[name]?.method,
        path: contract.routes[name]?.path,
      },
      { method, path },
      name,
    );
  }
  for (const method of ["list_members", "list_groups"])
    assert.ok(
      contract.dependencies.identity.includes(method),
      `dependencies.identity must include ${method}`,
    );
});

test("every catalog route declares request and response metadata with direct schema refs", () => {
  assert.deepEqual(metadataProblems(contract.routes), []);
});

test("route metadata mutations surface deterministic diagnostics", () => {
  const requestSchema = requestRef("list_things");
  const responseSchema = responseRef("list_things");
  const valid = {
    list_things: {
      method: "GET",
      path: "/things",
      request_body: { kind: "none", input: "query_and_path" },
      response_body: { kind: "json", schema: responseSchema },
      request_schema: requestSchema,
      response_schema: responseSchema,
    },
    publish_thing: {
      method: "POST",
      path: "/things",
      request_body: {
        kind: "multipart",
        content_type: "multipart/form-data",
        schema: requestRef("publish_thing"),
      },
      request_schema: requestRef("publish_thing"),
      response_body: { kind: "json", schema: responseRef("publish_thing") },
      response_schema: responseRef("publish_thing"),
    },
    download_thing: {
      method: "GET",
      path: "/things/{thing_id}/artifact",
      request_body: { kind: "none", input: "query_and_path" },
      request_schema: requestRef("download_thing"),
      response_body: { kind: "binary", content_type: "application/zip" },
      response_schema: responseRef("download_thing"),
    },
    watch_thing: {
      method: "GET",
      path: "/things/{thing_id}/watch",
      request_body: { kind: "none", input: "query_and_path" },
      request_schema: requestRef("watch_thing"),
      response_body: {
        kind: "event_stream",
        content_type: "text/event-stream",
        event: "agent_event",
        event_id: "global_sequence",
        data: responseRef("watch_thing"),
      },
      response_schema: responseRef("watch_thing"),
    },
  };
  assert.deepEqual(metadataProblems(valid), []);
  const mutations = [];
  const missingRef = structuredClone(valid);
  delete missingRef.list_things.request_schema;
  mutations.push([missingRef, "request_schema"]);
  const missingBody = structuredClone(valid);
  delete missingBody.list_things.response_body;
  mutations.push([missingBody, "response_body"]);
  const wrongKind = structuredClone(valid);
  wrongKind.list_things.request_body = { kind: "json" };
  mutations.push([wrongKind, "schema"]);
  const mismatched = structuredClone(valid);
  mismatched.list_things.request_body = {
    kind: "json",
    schema: "other.schema.json#/$defs/request",
  };
  mutations.push([mismatched, "request_body.schema"]);
  const silentZip = structuredClone(valid);
  delete silentZip.download_thing.response_body.content_type;
  mutations.push([silentZip, "content_type"]);
  const silentWatch = structuredClone(valid);
  delete silentWatch.watch_thing.response_body.data;
  mutations.push([silentWatch, "data"]);
  const wrongRef = structuredClone(valid);
  wrongRef.watch_thing.response_schema = "admin-api.schema.json#/$defs/status";
  mutations.push([wrongRef, "response_schema"]);
  for (const [routes, expected] of mutations) {
    const problems = metadataProblems(routes);
    assert.ok(
      problems.some((problem) => problem.includes(expected)),
      `${expected}: ${JSON.stringify(problems)}`,
    );
  }
});

test("caller catalog body kinds match the route metadata", () => {
  for (const [name, route] of Object.entries(contract.routes)) {
    const label = `${route.method} ${contract.base_path}${route.path}`;
    const policy = callers.routes[label];
    if (policy !== undefined)
      assert.equal(
        route.request_body?.kind,
        policy.request_body,
        `${name} request_body kind must match ${label}`,
      );
    else
      assert.equal(
        route.request_body?.kind,
        "none",
        `${name} is not cataloged and must not accept a body`,
      );
  }
});

function registeredAdminRoutes(sources) {
  const discovered = discoverRoutes(sources);
  const registered = new Set();
  const errors = [];
  for (const [path, scan] of Object.entries(discovered)) {
    if (sources[path].service !== "admin-console") continue;
    errors.push(...(scan.errors ?? []).map((error) => `${path}: ${error}`));
    for (const route of scan.routes ?? []) {
      const label = route.split(" ", 2)[1];
      if (label !== undefined && label.startsWith("/api/admin"))
        registered.add(route);
    }
  }
  return { registered, errors: errors.sort() };
}

test("every mux-registered and caller-cataloged admin route has a contract", () => {
  const declared = new Set(
    collectContractRoutes(contract.routes, contract.base_path),
  );
  const { registered, errors } = registeredAdminRoutes(collectSources());
  assert.deepEqual(errors, []);
  for (const route of [...registered].sort())
    assert.ok(
      declared.has(route),
      `registered route lacks a contract: ${route}`,
    );
  const cataloged = Object.keys(callers.routes).filter((route) =>
    route.split(" ", 2)[1]?.startsWith("/api/admin"),
  );
  for (const route of cataloged.sort())
    assert.ok(
      declared.has(route),
      `caller catalog route lacks a contract: ${route}`,
    );
  const unregistered = [...declared]
    .filter((route) => !registered.has(route))
    .sort();
  assert.ok(
    unregistered.every((route) => PLANNED_UNREGISTERED.includes(route)),
    `only the planned directory routes may lack registration: ${JSON.stringify(unregistered)}`,
  );
  const unpolicy = [...declared]
    .filter((route) => !(route in callers.routes))
    .sort();
  assert.ok(
    unpolicy.every((route) => PLANNED_UNREGISTERED.includes(route)),
    `only the planned directory routes may lack a caller policy: ${JSON.stringify(unpolicy)}`,
  );
});

test("an extra mux registration without a contract is flagged", () => {
  const anchor =
    'h.mux.HandleFunc("GET /api/admin/overview", h.withPrincipal(h.overview))';
  const sources = collectSources((path, source) =>
    path === "services/admin-console/internal/server/handler.go"
      ? source.replace(
          anchor,
          `${anchor}\n\th.mux.HandleFunc("GET /api/admin/mutant-extra", h.withPrincipal(h.overview))`,
        )
      : source,
  );
  const { registered, errors } = registeredAdminRoutes(sources);
  assert.deepEqual(errors, []);
  assert.ok(registered.has("GET /api/admin/mutant-extra"));
  const declared = new Set(
    collectContractRoutes(contract.routes, contract.base_path),
  );
  assert.ok(
    [...registered].some((route) => !declared.has(route)),
    "the coverage check must flag an undeclared registered route",
  );
});

test("admin-api.schema.json is a draft 2020-12 document with closed route definitions", () => {
  assert.ok(
    adminSchema !== undefined,
    "contracts/admin-console/admin-api.schema.json is missing",
  );
  assert.equal(
    adminSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(
    adminSchema.$id,
    "https://schemas.antnest.dev/admin-console/admin-api.schema.json",
  );
  assert.ok(isObject(adminSchema.$defs), "$defs must be an object");
  const routeNames = Object.keys(contract.routes);
  const definitionNames = Object.keys(adminSchema.$defs);
  for (const name of routeNames) {
    for (const kind of ["request", "response"]) {
      const definition = adminSchema.$defs[`${name}_${kind}`];
      assert.deepEqual(
        definitionProblems(definition, kind, `${name}_${kind}`),
        [],
      );
    }
  }
  for (const kind of ["request", "response"])
    assert.deepEqual(
      sorted(
        definitionNames
          .filter((name) => name.endsWith(`_${kind}`))
          .map((name) => name.slice(0, -`_${kind}`.length)),
      ),
      sorted(routeNames),
      `every ${kind} definition must belong to a declared route`,
    );
});

test("every route request and response definition resolves and enforces a real envelope", async () => {
  for (const name of Object.keys(contract.routes)) {
    await compile(adminDef(`${name}_request`));
    const validate = await compile(adminDef(`${name}_response`));
    assert.equal(
      validate({}),
      false,
      `${name}_response must reject an empty envelope`,
    );
  }
});

test("bodyless request definitions model exactly the declared path and query inputs", () => {
  for (const [name, route] of Object.entries(contract.routes)) {
    if (route.request_body?.kind !== "none") continue;
    const definition = adminSchema?.$defs?.[`${name}_request`];
    assert.equal(definition?.type, "object", `${name}_request`);
    assert.equal(
      definition?.additionalProperties,
      false,
      `${name}_request must be closed`,
    );
    assert.deepEqual(
      sortedKeys(definition.properties),
      sorted(expectedRequestProperties(route)),
      `${name}_request must model exactly the parsed query and path input`,
    );
    assert.deepEqual(
      sorted(definition.required ?? []),
      sorted(expectedRequiredProperties(route)),
      `${name}_request must require the path and required query input`,
    );
  }
});

test("directory member and group pages match the browser projection allowlist", async () => {
  const memberPage = await compile(adminDef("directory_members_response"));
  const groupPage = await compile(adminDef("directory_groups_response"));
  const legacy = await compile(adminDef("directory_response"));
  for (const [validate, member, group] of [
    [memberPage, directoryMember, undefined],
    [groupPage, undefined, directoryGroup],
  ]) {
    assert(validate({ items: member ? [member] : [group], next_cursor: null }));
    assert(
      validate({ items: member ? [member] : [group], next_cursor: "opaque" }),
    );
    assert(validate({ items: [], next_cursor: null }));
    assert(!validate({ items: member ? [member] : [group] }));
    assert(!validate({ items: member ? [member] : [group], next_cursor: 5 }));
    assert(
      !validate({
        items: member ? [member] : [group],
        next_cursor: null,
        extra: 1,
      }),
    );
    assert(
      !validate({
        items: member ? [member] : [group],
        next_cursor: null,
        pages: 1,
      }),
    );
    const overflow = { items: member ? [member] : [group], next_cursor: null };
    overflow.items = Array.from({ length: 201 }, () =>
      member ? member : group,
    );
    assert(!validate(overflow), "pages are bounded at 200 items");
  }
  assert(legacy({ users: [directoryMember], groups: [directoryGroup] }));
  assert(!legacy({ users: [directoryMember] }));
  assert(!legacy({ users: [directoryMember], groups: [], next_cursor: null }));
  for (const key of [
    "id",
    "system_role",
    "active",
    "created_at",
    "updated_at",
  ]) {
    const user = { ...directoryUser };
    delete user[key];
    assert(
      !memberPage({
        items: [{ user, membership: directoryMembership }],
        next_cursor: null,
      }),
      `user.${key} is required`,
    );
  }
  for (const key of [
    "id",
    "user_id",
    "email",
    "display_name",
    "role",
    "source",
    "active",
    "created_at",
    "updated_at",
  ]) {
    const membership = { ...directoryMembership };
    delete membership[key];
    assert(
      !memberPage({
        items: [{ user: directoryUser, membership }],
        next_cursor: null,
      }),
      `membership.${key} is required`,
    );
  }
  for (const field of [
    "credential_ref",
    "organization_id",
    "scim_external_id",
  ]) {
    assert(
      !memberPage({
        items: [
          {
            user: { ...directoryUser, [field]: "private" },
            membership: directoryMembership,
          },
        ],
        next_cursor: null,
      }),
      `user.${field} must stay private`,
    );
    assert(
      !memberPage({
        items: [
          {
            user: directoryUser,
            membership: { ...directoryMembership, [field]: "private" },
          },
        ],
        next_cursor: null,
      }),
      `membership.${field} must stay private`,
    );
  }
  assert(
    !memberPage({
      items: [
        {
          user: directoryUser,
          membership: directoryMembership,
          organization_id: "org-1",
        },
      ],
      next_cursor: null,
    }),
  );
  for (const key of [
    "display_name",
    "source",
    "active",
    "created_at",
    "updated_at",
  ]) {
    const group = { ...directoryGroup };
    delete group[key];
    assert(!groupPage({ items: [group], next_cursor: null }), `group.${key}`);
  }
  for (const field of ["id", "organization_id", "scim_external_id"])
    assert(
      !groupPage({
        items: [{ ...directoryGroup, [field]: "private" }],
        next_cursor: null,
      }),
      `group.${field} must stay unprojected`,
    );
});

test("directory list requests keep the canonical cursor query without retired aliases", async () => {
  for (const [name, queryNames] of [
    ["directory_members", ["active", "cursor", "limit", "q", "role", "source"]],
    ["directory_groups", ["active", "cursor", "limit", "q", "source"]],
  ]) {
    const definition = adminSchema?.$defs?.[`${name}_request`];
    assert.equal(definition?.type, "object", `${name}_request`);
    assert.equal(definition?.additionalProperties, false, `${name}_request`);
    assert.deepEqual(sortedKeys(definition?.properties), queryNames, name);
    for (const retired of [
      "after",
      "after_id",
      "email_prefix",
      "display_name_prefix",
    ])
      assert.ok(!(retired in (definition?.properties ?? {})), retired);
    assert.ok(isObject(definition), `${name}_request is missing`);
    const property = (key) =>
      resolveLocalDef(adminSchema, definition.properties[key]);
    const limit =
      JSON.stringify(definition.properties.limit) +
      JSON.stringify(property("limit"));
    assert.ok(limit.includes('"default":50'), `${name} limit default`);
    assert.ok(limit.includes('"minimum":1'), `${name} limit minimum`);
    assert.ok(limit.includes('"maximum":200'), `${name} limit maximum`);
    assert.equal(property("q")?.type, "string", `${name} q`);
    assert.deepEqual(
      sorted(property("source")?.enum ?? []),
      ["local", "scim"],
      `${name} source`,
    );
    assert.equal(property("active")?.type, "boolean", `${name} active`);
    if (name === "directory_members")
      assert.deepEqual(
        sorted(property("role")?.enum ?? []),
        ["admin", "member"],
        "directory member role",
      );
    const validate = await compile(adminDef(`${name}_request`));
    assert(validate({}));
    assert(validate({ limit: 50 }));
    assert(
      validate({
        cursor: "opaque",
        limit: 200,
        q: "member",
        active: true,
        source: "scim",
        ...(name === "directory_members" ? { role: "admin" } : {}),
      }),
    );
    for (const input of [
      { limit: 0 },
      { limit: 201 },
      { limit: "50" },
      { cursor: 5 },
      { q: 5 },
      { active: "true" },
      { source: "oidc" },
      { after: "x" },
      { after_id: "x" },
      { bogus: 1 },
      ...(name === "directory_members"
        ? [{ role: "owner" }]
        : [{ role: "admin" }]),
    ])
      assert(!validate(input), `${name} rejects ${JSON.stringify(input)}`);
  }
});

test("media types are explicit for multipart uploads, the zip download and the event watch", async () => {
  for (const name of ["publish_skill", "publish_skill_version"]) {
    const route = contract.routes[name];
    assert.deepEqual(route.request_body, {
      kind: "multipart",
      content_type: "multipart/form-data",
      schema: requestRef(name),
    });
    const definition = adminSchema?.$defs?.[`${name}_request`];
    assert.equal(definition?.type, "object", `${name}_request`);
    assert.equal(definition?.additionalProperties, false, `${name}_request`);
    assert.ok(
      (definition?.required ?? []).includes("artifact"),
      `${name} artifact`,
    );
    if (name === "publish_skill_version")
      assert.ok(
        (definition?.required ?? []).includes("expected_version"),
        "publish_skill_version expected_version",
      );
  }
  const download = contract.routes.download_skill_version;
  assert.deepEqual(download.response_body, {
    kind: "binary",
    content_type: "application/zip",
  });
  const zip = adminSchema?.$defs?.download_skill_version_response;
  assert.equal(zip?.type, "string");
  assert.equal(zip?.contentMediaType, "application/zip");
  const watch = contract.routes.watch_agent_events;
  assert.deepEqual(watch.response_body, {
    kind: "event_stream",
    content_type: "text/event-stream",
    event: "agent_event",
    event_id: "global_sequence",
    data: responseRef("watch_agent_events"),
  });
  const validate = await compile(adminDef("watch_agent_events_response"));
  const event = {
    event_id: "event-1",
    global_sequence: 7,
    aggregate_sequence: 3,
    schema_version: 1,
    agent_id: "agent-1",
    event_type: "agent_ready",
    occurred_at: timestamp,
  };
  assert(validate(event));
  assert(
    validate({ ...event, trace_id: "trace-1", operation_request_id: "req-1" }),
  );
  for (const key of [
    "event_id",
    "global_sequence",
    "aggregate_sequence",
    "agent_id",
    "event_type",
    "occurred_at",
  ]) {
    const broken = { ...event };
    delete broken[key];
    assert(!validate(broken), `event ${key} is required`);
  }
  assert(
    !validate({ ...event, runtime_mcp_endpoint: "http://private" }),
    "private event fields must not pass",
  );
  assert(
    !validate({ ...event, data: { runtime_mcp_endpoint: "http://private" } }),
  );
});

test("identity directory schema documents the bounded member and group methods", async () => {
  assert.ok(
    directorySchema !== undefined,
    "contracts/identity/directory.schema.json is missing",
  );
  assert.equal(
    directorySchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(
    directorySchema.$id,
    "https://schemas.antnest.dev/identity/directory.schema.json",
  );
  const filters = {
    list_members: ["active", "email_prefix", "role", "source"],
    list_groups: ["active", "display_name_prefix", "source"],
  };
  for (const method of ["list_members", "list_groups"]) {
    const request = directorySchema.$defs[`${method}_request`];
    assert.equal(request?.type, "object", `${method}_request`);
    assert.equal(
      request?.additionalProperties,
      false,
      `${method}_request must be closed`,
    );
    assert.deepEqual(
      sorted(request?.required ?? []),
      ["actor_principal_id", "limit", "organization_id"],
      `${method}_request required`,
    );
    assert.deepEqual(
      sortedKeys(request?.properties),
      ["actor_principal_id", "cursor", "filter", "limit", "organization_id"],
      `${method}_request properties`,
    );
    assert.ok(!("after" in (request?.properties ?? {})), `${method} after`);
    const limit =
      JSON.stringify(request.properties.limit) +
      JSON.stringify(
        resolveLocalDef(directorySchema, request.properties.limit),
      );
    assert.ok(limit.includes('"minimum":1'), `${method} limit minimum`);
    assert.ok(limit.includes('"maximum":200'), `${method} limit maximum`);
    const filter = resolveLocalDef(directorySchema, request.properties.filter);
    assert.equal(
      filter?.type,
      "object",
      `${method} filter must be a closed object`,
    );
    assert.equal(filter?.additionalProperties, false, `${method} filter`);
    assert.deepEqual(sortedKeys(filter?.properties), filters[method], method);
    const filterProperty = (name) =>
      resolveLocalDef(directorySchema, filter.properties[name]);
    assert.deepEqual(
      sorted(filterProperty("source")?.enum ?? []),
      ["local", "scim"],
      `${method} source`,
    );
    assert.equal(filterProperty("active")?.type, "boolean", `${method} active`);
    if (method === "list_members") {
      assert.deepEqual(
        sorted(filterProperty("role")?.enum ?? []),
        ["admin", "member"],
        "member role",
      );
      assert.equal(filterProperty("email_prefix")?.type, "string");
    } else {
      assert.equal(filterProperty("display_name_prefix")?.type, "string");
      assert.ok(!("role" in filter.properties), "group filter has no role");
    }
    const response = directorySchema.$defs[`${method}_response`];
    assert.equal(response?.type, "object", `${method}_response`);
    assert.equal(
      response?.additionalProperties,
      false,
      `${method}_response must be closed`,
    );
    assert.deepEqual(
      sorted(response?.required ?? []),
      ["items", "next_cursor"],
      `${method}_response required`,
    );
    assert.equal(response?.properties?.items?.maxItems, 200, `${method} items`);
    assert.ok(
      JSON.stringify(response?.properties?.next_cursor ?? {}).includes(
        "pagination.schema.json#/$defs/nullable_cursor",
      ),
      `${method} next_cursor must reuse the shared nullable cursor`,
    );
    const validateRequest = await compile(identityDef(`${method}_request`));
    const validateResponse = await compile(identityDef(`${method}_response`));
    assert(
      validateRequest({
        actor_principal_id: "a",
        organization_id: "o",
        limit: 1,
      }),
    );
    assert(
      validateRequest({
        actor_principal_id: "a",
        organization_id: "o",
        limit: 200,
        cursor: "opaque",
        filter:
          method === "list_members"
            ? {
                email_prefix: "member",
                role: "admin",
                active: true,
                source: "scim",
              }
            : {
                display_name_prefix: "ops",
                active: false,
                source: "local",
              },
      }),
    );
    for (const input of [
      { organization_id: "o", limit: 1 },
      { actor_principal_id: "a", limit: 1 },
      { actor_principal_id: "a", organization_id: "o" },
      { actor_principal_id: "a", organization_id: "o", limit: 0 },
      { actor_principal_id: "a", organization_id: "o", limit: 201 },
      { actor_principal_id: "a", organization_id: "o", limit: "50" },
      { actor_principal_id: "a", organization_id: "o", limit: 1, after: "x" },
      {
        actor_principal_id: "a",
        organization_id: "o",
        limit: 1,
        filter: { bogus: 1 },
      },
      ...(method === "list_members"
        ? [
            {
              actor_principal_id: "a",
              organization_id: "o",
              limit: 1,
              filter: { role: "owner" },
            },
          ]
        : [
            {
              actor_principal_id: "a",
              organization_id: "o",
              limit: 1,
              filter: { role: "admin" },
            },
          ]),
    ])
      assert(
        !validateRequest(input),
        `${method} rejects ${JSON.stringify(input)}`,
      );
    const item =
      method === "list_members"
        ? { user: directoryUser, membership: internalMembership }
        : internalGroup;
    assert(validateResponse({ items: [item], next_cursor: null }));
    assert(validateResponse({ items: [], next_cursor: "opaque" }));
    assert(!validateResponse({ items: [item] }));
    assert(!validateResponse({ items: [item], next_cursor: 5 }));
    assert(
      !validateResponse({
        items: Array.from({ length: 201 }, () => item),
        next_cursor: null,
      }),
    );
    assert(!validateResponse({ items: [item], next_cursor: null, extra: 1 }));
    assert(!validateResponse({}));
    const broken =
      method === "list_members"
        ? {
            user: directoryUser,
            membership: (({ email, ...rest }) => rest)(internalMembership),
          }
        : (({ display_name, ...rest }) => rest)(internalGroup);
    assert(!validateResponse({ items: [broken], next_cursor: null }));
  }
});

test("the identity descriptor refs the directory schema and keeps inline shapes", () => {
  for (const method of ["list_members", "list_groups"]) {
    const entry = identity.methods[method];
    assert.ok(entry !== undefined, `methods.${method} is missing`);
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, `/${method.replace(/_/g, "-")}`);
    for (const side of ["request", "response"]) {
      assert.equal(
        entry[side].$ref,
        `directory.schema.json#/$defs/${method}_${side}`,
        `${method}.${side}.$ref`,
      );
      assert.deepEqual(
        sorted(entry[side].required ?? []),
        sorted(
          directorySchema?.$defs?.[`${method}_${side}`]?.required ?? [
            "missing",
          ],
        ),
        `${method}.${side} inline required must match the schema`,
      );
      assert.deepEqual(
        sortedKeys(entry[side].properties),
        sortedKeys(
          directorySchema?.$defs?.[`${method}_${side}`]?.properties ?? {
            missing: true,
          },
        ),
        `${method}.${side} inline properties must match the schema`,
      );
    }
  }
  const legacy = identity.methods.list_directory;
  assert.equal(legacy.response.properties.users.maxItems, 200);
  assert.equal(legacy.response.properties.groups.maxItems, 200);
  assert.ok(
    legacy.deprecated ?? legacy.deprecation,
    "list_directory must carry a deprecation note",
  );
});

test("the error documentation view maps slice codes to the shared registry", () => {
  assert.equal(contract.error.$ref, "../common/error.schema.json");
  assert.equal(contract.error.codes, "../common/slices/admin-console.json");
  assert.equal(
    contract.error.view,
    "errors.json",
    "the catalog must reference the generated service error view",
  );
  assert.ok(
    errorsView !== undefined,
    "contracts/admin-console/errors.json is missing",
  );
  assert.deepEqual(
    errorsViewProblems(errorsView, slice.codes, registryByCode),
    [],
  );
});

test("the error view rejects drift in either direction", () => {
  const valid = {
    service: "admin-console",
    source: "../common/errors.json",
    errors: slice.codes.map((code) => {
      const entry = registryByCode.get(code);
      return {
        code,
        status: entry.http_status,
        retryable: entry.retryable,
        description: entry.description,
      };
    }),
  };
  assert.deepEqual(errorsViewProblems(valid, slice.codes, registryByCode), []);
  const dropped = structuredClone(valid);
  dropped.errors = dropped.errors.filter(
    (entry) => entry.code !== slice.codes[0],
  );
  assert.notDeepEqual(
    errorsViewProblems(dropped, slice.codes, registryByCode),
    [],
  );
  const extra = structuredClone(valid);
  extra.errors.push({
    code: "made_up_code",
    status: 500,
    retryable: false,
    description: "independent constant",
  });
  assert.notDeepEqual(
    errorsViewProblems(extra, slice.codes, registryByCode),
    [],
  );
  const drifted = structuredClone(valid);
  drifted.errors[0].status = 418;
  assert.notDeepEqual(
    errorsViewProblems(drifted, slice.codes, registryByCode),
    [],
  );
  const widened = structuredClone(valid);
  widened.errors[0].category = "internal";
  assert.notDeepEqual(
    errorsViewProblems(widened, slice.codes, registryByCode),
    [],
  );
  const alien = structuredClone(valid);
  alien.service = "edge-gateway";
  assert.notDeepEqual(
    errorsViewProblems(alien, slice.codes, registryByCode),
    [],
  );
});

test("generated Go and TypeScript catalogs remain derived from the slice", () => {
  const expected = sorted(slice.codes);
  const goCodes = sorted(
    new Set(
      [...goErrors.matchAll(/= "([a-z][a-z0-9_]+)"/g)].map((match) => match[1]),
    ),
  );
  const tsCodes = sorted(
    new Set(
      [...tsErrors.matchAll(/: "([a-z][a-z0-9_]+)"/g)].map((match) => match[1]),
    ),
  );
  assert.deepEqual(goCodes, expected, "errors.gen.go codes");
  assert.deepEqual(tsCodes, expected, "errors.gen.ts codes");
});

test("oidc provider and upsert payloads expose the full typed policy surface", async () => {
  const provider = {
    name: "corp-idp",
    display_name: "Corp IdP",
    issuer: "https://idp.example.com",
    client_id: "client-1",
    scopes: ["openid"],
    enabled: true,
    revision: 3,
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    token_endpoint_auth_method: "client_secret_basic",
    id_token_signing_algs: ["RS256"],
    jwks_uri: "https://idp.example.com/jwks",
    created_at: timestamp,
    updated_at: timestamp,
    link_policy: "verified_email",
    link_domains: ["example.com"],
    authoritative: false,
    link_policy_review_required: false,
  };
  const providers = await compile(adminDef("list_oidc_providers_response"));
  assert(providers({ providers: [provider] }));
  for (const key of [
    "link_policy",
    "link_domains",
    "authoritative",
    "link_policy_review_required",
  ]) {
    const broken = { ...provider };
    delete broken[key];
    assert(!providers({ providers: [broken] }), `provider ${key} is required`);
  }
  const request = await compile(adminDef("upsert_oidc_provider_request"));
  const minimal = {
    name: "corp-idp",
    issuer: "https://idp.example.com",
    client_id: "client-1",
    enabled: true,
  };
  assert(request(minimal), "client_secret and scopes stay optional");
  assert(
    request({ ...minimal, client_secret: "s", scopes: ["openid"] }),
    "creation input may carry secret and scopes",
  );
  for (const key of ["name", "issuer", "client_id", "enabled"]) {
    const broken = { ...minimal };
    delete broken[key];
    assert(!request(broken), `upsert ${key} is required`);
  }
  assert(
    request({
      ...minimal,
      link_policy: "verified_email_in_domains",
      link_domains: ["example.com"],
      authoritative: true,
    }),
  );
  assert(
    request({
      ...minimal,
      link_policy: "verified_email",
      link_domains: ["example.com"],
      authoritative: false,
      acknowledge_link_policy_review: true,
    }),
  );
  for (const input of [
    { ...minimal, link_policy: "bogus" },
    { ...minimal, link_policy: "verified_email" },
    { ...minimal, link_domains: ["example.com"] },
    { ...minimal, authoritative: true },
    { ...minimal, acknowledge_link_policy_review: true },
    { ...minimal, link_policy: "verified_email", link_domains: "example.com" },
    {
      ...minimal,
      link_policy: "verified_email",
      link_domains: ["example.com"],
      authoritative: "yes",
    },
  ])
    assert(!request(input), `upsert rejects ${JSON.stringify(input)}`);
});

test("execution audit envelopes match the projected stream and synchronization wire", async () => {
  const events = await compile(adminDef("list_execution_events_response"));
  const message = {
    id: "event-1",
    sequence: 4,
    kind: "model_request",
    visible: true,
    payload: {},
    created_at: timestamp,
  };
  const permission = {
    tool_call_id: "tool-1",
    request: {},
    decision: null,
    reason: null,
    created_at: timestamp,
    decided_at: null,
  };
  assert(
    events({ stream: "execution", items: [message], next_cursor: null }),
    "execution stream page",
  );
  assert(
    events({ stream: "permissions", items: [permission], next_cursor: null }),
    "permissions stream page with nullable decision fields",
  );
  assert(
    !events({ items: [message], next_cursor: null }),
    "stream is required",
  );
  assert(
    !events({ stream: "bogus", items: [message], next_cursor: null }),
    "stream enum",
  );
  assert(
    !events({ stream: "execution", items: [permission], next_cursor: null }),
    "execution stream must carry audit messages",
  );
  const droppedDecision = { ...permission };
  delete droppedDecision.decision;
  assert(
    !events({
      stream: "permissions",
      items: [droppedDecision],
      next_cursor: null,
    }),
    "decision is a required nullable field",
  );
  const synchronization = await compile(
    adminDef("get_execution_synchronization_response"),
  );
  assert(synchronization({ synchronization: null }));
  assert(
    synchronization({
      synchronization: {
        revision: 5,
        applied_revision: null,
        updated_at: timestamp,
        applied_at: null,
      },
    }),
    "applied fields are required and nullable",
  );
  const missingApplied = {
    revision: 5,
    updated_at: timestamp,
    applied_at: null,
  };
  assert(
    !synchronization({ synchronization: missingApplied }),
    "applied_revision is required",
  );
  const detail = await compile(adminDef("get_execution_audit_response"));
  const audit = {
    run_id: "run-1",
    session_id: "session-1",
    agent_id: "agent-1",
    principal_id: "principal-1",
    state: "finished",
    created_at: timestamp,
    updated_at: timestamp,
    input: {},
    execution_snapshot: null,
    terminal_class: null,
    executor_state: null,
    tool_effect_state: null,
    stop_reason: null,
    error_class: null,
    model_profile_revision: null,
    usage_measurements: [],
  };
  assert(detail(audit), "execution_snapshot may be null");
  assert(
    detail({ ...audit, execution_snapshot: {} }),
    "execution_snapshot may be the empty projection",
  );
});

test("overview sections enforce typed per-resource envelopes and closed defaults", async () => {
  const overview = await compile(adminDef("overview_response"));
  const page = { items: [], next_cursor: null };
  const legacy = { users: [], groups: [] };
  const valid = {
    directory: { status: "available", data: legacy },
    model_profiles: { status: "available", data: page },
    templates: { status: "available", data: page },
    agents: { status: "available", data: page },
    defaults: { runtime_image_ref: "runtime:current" },
  };
  assert(overview(valid));
  const wrongData = structuredClone(valid);
  wrongData.agents = { status: "available", data: legacy };
  assert(!overview(wrongData), "agents data must match the agent page");
  const missingError = structuredClone(valid);
  missingError.directory = { status: "unavailable" };
  assert(!overview(missingError), "unavailable requires error");
  const strayData = structuredClone(valid);
  strayData.directory = {
    status: "unavailable",
    error: { status: 500, code: "unavailable", message: "failure" },
    data: legacy,
  };
  assert(!overview(strayData), "unavailable must not carry data");
  const wrongDefaults = structuredClone(valid);
  wrongDefaults.defaults = { runtime_image_ref: "runtime:current", extra: "x" };
  assert(!overview(wrongDefaults), "defaults is a closed object");
});

test("template inputs share the typed runtime surface with relaxed required fields", async () => {
  const create = await compile(adminDef("create_template_request"));
  assert(create({ name: "template", model_profile_id: "profile-1" }));
  assert(
    create({
      name: "template",
      model_profile_id: "profile-1",
      system_prompt: "prompt",
      max_model_requests: 3,
      runtime: {
        image_ref: "runtime:current",
        resources: { memory_bytes: 1024, cpu_millis: 500 },
        mcp_servers: [{ id: "server", command: "mcp-server" }],
      },
      skill_refs: [{ skill_id: "skill-1", version: 1 }],
    }),
  );
  assert(!create({ name: "template" }), "model_profile_id is required");
  const revise = await compile(adminDef("revise_template_request"));
  assert(
    revise({
      name: "template",
      model_profile_id: "profile-1",
      max_model_requests: 5,
    }),
    "runtime and system_prompt keep server defaults",
  );
  assert(
    !revise({
      name: "template",
      model_profile_id: "profile-1",
      max_model_requests: 0,
    }),
    "max_model_requests minimum 1",
  );
});

test("legacy directory arrays are capped and deprecated aliases reject ambiguity", async () => {
  const legacy = await compile(adminDef("directory_response"));
  assert(
    !legacy({
      users: Array.from({ length: 201 }, () => directoryMember),
      groups: [],
    }),
    "legacy users page bounded at 200",
  );
  assert(
    !legacy({
      users: [],
      groups: Array.from({ length: 201 }, () => directoryGroup),
    }),
    "legacy groups page bounded at 200",
  );
  for (const [name, requiredInput] of [
    ["list_skills", {}],
    ["list_organization_sessions", { user_id: "user-1", limit: 5 }],
    ["list_model_profiles", {}],
    ["list_templates", {}],
    ["list_provider_connections", {}],
  ]) {
    const validate = await compile(adminDef(`${name}_request`));
    assert(
      !validate({ ...requiredInput, cursor: "opaque", after_id: "stale" }),
      `${name} rejects cursor with after_id`,
    );
    assert(
      validate({ ...requiredInput, after_id: "stale" }),
      `${name} accepts the alias alone`,
    );
  }
  const versions = await compile(adminDef("list_skill_versions_request"));
  assert(
    !versions({ skill_id: "skill-1", cursor: "opaque", after_version: "v1" }),
    "cursor plus after_version is ambiguous",
  );
  const policy = await compile(adminDef("set_agent_network_policy_request"));
  assert(
    !policy({
      action: "allow_all",
      expected_version: "v1",
      expected_resource_version: 4,
    }),
    "canonical and legacy CAS are mutually exclusive",
  );
  assert(
    policy({ action: "allow_all", expected_resource_version: 4 }),
    "legacy CAS form remains accepted",
  );
});
