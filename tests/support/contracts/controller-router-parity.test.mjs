import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectSources,
  discoverRoutes,
} from "../check-service-authentication.mjs";
import { collectContractRoutes, routeParityProblems } from "./route-parity.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const contractDir = resolve(root, "contracts/agent-controller");
const contract = JSON.parse(
  readFileSync(resolve(contractDir, "control-contract.json"), "utf8"),
);
const callers = JSON.parse(
  readFileSync(resolve(contractDir, "callers.json"), "utf8"),
);

const handlerPath = "services/agent-controller/internal/server/handler.go";
const wrapperPath =
  "services/agent-controller/internal/server/model_call_policy.go";
const statusAnchor = `{pattern: "GET /status", handler: h.status, metadataOnly: true},`;
const learningAnchor = `{pattern: "GET /internal/agents/{agent_id}/skill-learning-policy", handler: h.getSkillLearningPolicy, metadataOnly: true},\n\t\t`;

const declared = collectContractRoutes(contract);
const callerRoutes = Object.entries(callers.routes)
  .filter(
    ([route, policy]) =>
      policy.authentication !== "deny" && !route.startsWith("*"),
  )
  .map(([route]) => route);
const pinned = [
  "GET /status",
  "GET /rpc/agent-controller/status",
  "GET /internal/agents/{agent_id}/skill-learning-policy",
  "PUT /internal/agents/{agent_id}/skill-learning-policy",
];

function controllerSources(mutate) {
  const owned = {};
  for (const [path, entry] of Object.entries(collectSources()))
    if (entry.service === "agent-controller" && path.endsWith(".go"))
      owned[path] = { ...entry };
  if (mutate) mutate(owned);
  return owned;
}

function registeredRoutes(sources) {
  const discovered = discoverRoutes(sources);
  const routes = [];
  const errors = [];
  for (const [path, result] of Object.entries(discovered)) {
    errors.push(...(result.errors ?? []).map((error) => `${path}: ${error}`));
    for (const route of result.routes ?? [])
      if (!route.startsWith("*")) routes.push(route);
  }
  return { routes: [...new Set(routes)].sort(), errors: errors.sort() };
}

const schemaCache = new Map();
function resolveLocalRef(ref) {
  const [file, pointer = ""] = ref.split("#");
  const schemaPath = resolve(contractDir, file);
  if (!existsSync(schemaPath)) return undefined;
  if (!schemaCache.has(schemaPath))
    schemaCache.set(schemaPath, JSON.parse(readFileSync(schemaPath, "utf8")));
  return pointer
    .split("/")
    .filter(Boolean)
    .reduce((node, key) => node?.[key], schemaCache.get(schemaPath));
}

function catalogReferenceProblems(document) {
  const problems = [];
  const routeObjects = [document.status, document.status_rpc];
  for (const resource of Object.values(document.resources ?? {}))
    for (const operation of Object.values(resource))
      if (
        operation &&
        typeof operation.method === "string" &&
        typeof operation.path === "string"
      )
        routeObjects.push(operation);
  for (const route of routeObjects) {
    const label = `${route.method} ${route.path}`;
    if (route.method !== "GET" && !route.request)
      problems.push(`${label} lacks a request schema`);
    if (
      route.request !== undefined &&
      resolveLocalRef(route.request) === undefined
    )
      problems.push(`${label} unresolved request: ${route.request}`);
    if (route.content_type === "text/event-stream") {
      for (const field of ["data", "event", "event_id"])
        if (route[field] === undefined)
          problems.push(`${label} SSE route lacks ${field}`);
      if (route.data !== undefined && resolveLocalRef(route.data) === undefined)
        problems.push(`${label} unresolved data: ${route.data}`);
    } else if (route.response === undefined) {
      problems.push(`${label} lacks a response schema`);
    } else if (resolveLocalRef(route.response) === undefined) {
      problems.push(`${label} unresolved response: ${route.response}`);
    }
  }
  if (resolveLocalRef(document.errors.response) === undefined)
    problems.push(`unresolved errors.response: ${document.errors.response}`);
  return problems.sort();
}

test("the Controller mux registers exactly the contract and caller routes", () => {
  const { routes, errors } = registeredRoutes(controllerSources());
  assert.deepEqual(errors, []);
  assert.deepEqual(routeParityProblems(declared, routes), []);
  assert.deepEqual(routeParityProblems(declared, callerRoutes), []);
  for (const route of pinned) {
    assert.ok(declared.includes(route), `contract missing ${route}`);
    assert.ok(routes.includes(route), `mux missing ${route}`);
    assert.ok(callerRoutes.includes(route), `callers missing ${route}`);
  }
});

test("an extra routeDefinition in handler.routes is flagged without a contract", () => {
  const { routes, errors } = registeredRoutes(
    controllerSources((sources) => {
      const source = sources[handlerPath].source;
      assert.ok(source.includes(statusAnchor));
      sources[handlerPath].source = source.replace(
        statusAnchor,
        `${statusAnchor}\n\t\t{pattern: "GET /mutant-extra", handler: h.status},`,
      );
    }),
  );
  assert.deepEqual(errors, []);
  assert.ok(routes.includes("GET /mutant-extra"));
  assert.ok(
    routeParityProblems(declared, routes).includes(
      "registered route has no contract: GET /mutant-extra",
    ),
  );
});

test("a removed learning route is flagged as unregistered by the catalog", () => {
  const { routes, errors } = registeredRoutes(
    controllerSources((sources) => {
      const source = sources[handlerPath].source;
      assert.ok(source.includes(learningAnchor));
      sources[handlerPath].source = source.replace(learningAnchor, "");
    }),
  );
  assert.deepEqual(errors, []);
  assert.ok(
    routeParityProblems(declared, routes).includes(
      "contract route is not registered: GET /internal/agents/{agent_id}/skill-learning-policy",
    ),
  );
});

test("a literal mux.HandleFunc in a policy wrapper file is flagged the same way", () => {
  const { routes, errors } = registeredRoutes(
    controllerSources((sources) => {
      sources[wrapperPath].source += `
func mutantWrapperRoute() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /mutant-wrapper", func(http.ResponseWriter, *http.Request) {})
	_ = mux
}
`;
    }),
  );
  assert.deepEqual(errors, []);
  assert.ok(routes.includes("GET /mutant-wrapper"));
  assert.ok(
    routeParityProblems(declared, routes).includes(
      "registered route has no contract: GET /mutant-wrapper",
    ),
  );
});

test("an unresolved dynamic route pattern surfaces a scanner error", () => {
  const { errors } = registeredRoutes(
    controllerSources((sources) => {
      sources[wrapperPath].source += `
func mutantDynamicRoute(mux *http.ServeMux, pattern string) {
	mux.HandleFunc(pattern, func(http.ResponseWriter, *http.Request) {})
}
`;
    }),
  );
  assert.ok(errors.length > 0, "scanner must report the unresolved pattern");
});

test("catalog route references resolve to local schemas", () => {
  assert.deepEqual(catalogReferenceProblems(contract), []);
  assert.equal(contract.status.method, "GET");
  assert.equal(contract.status_rpc.method, "GET");
  assert.ok(resolveLocalRef(contract.status.response));
  assert.ok(resolveLocalRef(contract.status_rpc.response));
});

test("catalog and caller mutations surface deterministic diagnostics", () => {
  const missingResponse = structuredClone(contract);
  delete missingResponse.resources.agents.get.response;
  assert.ok(
    catalogReferenceProblems(missingResponse).includes(
      "GET /internal/agents/{agent_id} lacks a response schema",
    ),
  );

  const missingData = structuredClone(contract);
  delete missingData.resources.events.watch_global.data;
  assert.ok(
    catalogReferenceProblems(missingData).includes(
      "GET /internal/agent-events/watch SSE route lacks data",
    ),
  );

  const thinCallers = { ...callers.routes };
  delete thinCallers["GET /internal/agents/{agent_id}/skill-learning-policy"];
  assert.ok(
    routeParityProblems(declared, Object.keys(thinCallers)).includes(
      "contract route is not registered: GET /internal/agents/{agent_id}/skill-learning-policy",
    ),
  );
});

test("main composition and the typed handler own the learning routes", () => {
  const mainSource = readFileSync(
    resolve(root, "services/agent-controller/cmd/agent-controller/main.go"),
    "utf8",
  );
  assert.ok(
    mainSource.includes(
      "application.NewSkillLearningPolicyService(repository, identity)",
    ),
  );
  assert.ok(!mainSource.includes("WithSkillLearningPolicyRoutes"));
  const handlerSource = readFileSync(resolve(root, handlerPath), "utf8");
  assert.ok(handlerSource.includes("learning SkillLearningPolicyService"));
  for (const entry of [
    `{pattern: "GET /internal/agents/{agent_id}/skill-learning-policy", handler: h.getSkillLearningPolicy, metadataOnly: true}`,
    `{pattern: "PUT /internal/agents/{agent_id}/skill-learning-policy", handler: h.setSkillLearningPolicy, metadataOnly: true}`,
  ])
    assert.ok(handlerSource.includes(entry), entry);
  const policySource = readFileSync(
    resolve(
      root,
      "services/agent-controller/internal/server/skill_learning_policy.go",
    ),
    "utf8",
  );
  assert.ok(
    policySource.includes("func (h *handler) getSkillLearningPolicy("),
    "typed getSkillLearningPolicy",
  );
  assert.ok(
    policySource.includes("func (h *handler) setSkillLearningPolicy("),
    "typed setSkillLearningPolicy",
  );
  assert.ok(!policySource.includes("func WithSkillLearningPolicyRoutes"));
});
