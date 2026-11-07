import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  collectSources,
  discoverRoutes,
} from "../../support/check-service-authentication.mjs";
import { routeBodyProblems } from "../../support/contracts/route-parity.mjs";

const rcDir = new URL(
  "../../../contracts/runtime-controller/",
  import.meta.url,
);
const contract = JSON.parse(
  readFileSync(new URL("control-contract.json", rcDir), "utf8"),
);
const callers = JSON.parse(
  readFileSync(new URL("callers.json", rcDir), "utf8"),
);
const schemaDocs = new Map();
for (const name of [
  "control-api.schema.json",
  "runtime-deployment.schema.json",
])
  schemaDocs.set(name, JSON.parse(readFileSync(new URL(name, rcDir), "utf8")));

const label = (route) => `${route.method} ${route.path}`;
const declared = contract.routes.map(label).sort();

function allowedRoutes() {
  return Object.entries(callers.routes)
    .filter(
      ([route, policy]) =>
        policy.authentication !== "deny" && !route.startsWith("* "),
    )
    .map(([route]) => route)
    .sort();
}

function normalized(routes) {
  return routes.map((route) => ({
    method: route.method,
    path: route.path,
    request_body: route.request_body,
    responses: Object.fromEntries(
      Object.entries(route.responses).map(([status, entry]) => [
        status,
        {
          body: entry.body,
          ...(entry.content_type ? { content_type: entry.content_type } : {}),
        },
      ]),
    ),
    errors: (route.errors ?? []).map((code) => ({
      code,
      status: contract.errors[code].status,
    })),
  }));
}

function resolveRef(reference) {
  const [file, fragment] = reference.split("#", 2);
  let doc = schemaDocs.get(file);
  if (doc === undefined) {
    const resolved = new URL(file, rcDir);
    assert(
      resolved.pathname.includes("/contracts/"),
      `ref escapes contracts area: ${reference}`,
    );
    doc = JSON.parse(readFileSync(resolved, "utf8"));
    schemaDocs.set(file, doc);
  }
  if (!fragment) return doc;
  let node = doc;
  for (const segment of fragment.replace(/^\//, "").split("/")) {
    node = node[segment];
    assert(node !== undefined, `missing ${reference}`);
  }
  return node;
}

function discovered(sourceMap) {
  const raw = discoverRoutes(sourceMap);
  const routes = new Set();
  for (const result of Object.values(raw)) {
    for (const entry of result.errors ?? [])
      assert.fail(`route scanner error: ${entry}`);
    for (const entry of result.routes ?? []) {
      const label =
        typeof entry === "string" ? entry : `${entry.method} ${entry.path}`;
      if (label.startsWith("* ") || !/^[A-Z]+ \//.test(label)) continue;
      routes.add(label);
    }
  }
  return [...routes].sort();
}

function rcSources(patch) {
  return Object.fromEntries(
    Object.entries(collectSources()).flatMap(([path, value]) =>
      path.startsWith("services/runtime-controller/") && path.endsWith(".go")
        ? [[path, { source: patch ? patch(path, value.source) : value.source }]]
        : [],
    ),
  );
}

test("published routes satisfy the complete body contract", () => {
  assert.deepEqual(routeBodyProblems(normalized(contract.routes)), []);
  for (const route of contract.routes)
    assert.equal(
      route.request_body !== undefined,
      true,
      `${route.method} ${route.path} missing request_body`,
    );
});

test("every declared body and error reference resolves inside the published schemas", () => {
  for (const route of contract.routes) {
    if (route.request_body && route.request_body !== "none")
      resolveRef(route.request_body);
    for (const entry of Object.values(route.responses)) {
      if (entry.body && entry.body !== "none") resolveRef(entry.body);
      if (entry.sse) {
        resolveRef(entry.sse.data);
        resolveRef(entry.sse.id);
      }
    }
    for (const code of route.errors ?? []) {
      const error = contract.errors[code];
      assert(error !== undefined, `${label(route)} unknown error ${code}`);
      assert(Number.isInteger(error.status), `${code} status`);
      if (error.body) resolveRef(error.body);
    }
  }
  for (const pointer of Object.values(contract.schemas)) resolveRef(pointer);
});

test("contract routes match the caller catalog and the real mux inventory", () => {
  assert.deepEqual(declared, allowedRoutes());
  const found = discovered(rcSources());
  assert.deepEqual(found, declared);
});

test("an injected mux registration is detected as an undeclared route", () => {
  const mutated = discovered(
    rcSources((path, source) =>
      path.endsWith("internal/rpc/handler.go")
        ? source.replace(
            'mux.HandleFunc("GET /status", handler.status)',
            'mux.HandleFunc("GET /status", handler.status)\n\tmux.HandleFunc("GET /internal/extra", handler.status)',
          )
        : source,
    ),
  );
  assert.notDeepEqual(mutated, declared);
});

test("the canonical location owns the contract and README lists it", () => {
  assert(
    !existsSync(
      new URL("../../../services/runtime-controller/api/", import.meta.url),
    ),
    "legacy api directory must be gone",
  );
  const readme = readFileSync(
    new URL("../../../contracts/README.md", import.meta.url),
    "utf8",
  );
  assert(
    readme.includes("[`runtime-controller/`](runtime-controller/)"),
    "README row must link the canonical runtime-controller/ directory",
  );
});

test("missing request or response body declarations fail the gate", () => {
  const mutated = contract.routes.map((route) => ({ ...route }));
  delete mutated.find((route) => route.method === "GET").request_body;
  assert.notDeepEqual(routeBodyProblems(normalized(mutated)), []);
  const dropped = contract.routes.map((route) => ({ ...route }));
  const target = dropped.find((route) =>
    Object.values(route.responses).some((entry) => entry.body !== undefined),
  );
  const status = Object.keys(target.responses)[0];
  const entry = { ...target.responses[status] };
  delete entry.body;
  target.responses = { ...target.responses, [status]: entry };
  assert.notDeepEqual(routeBodyProblems(normalized(dropped)), []);
});
