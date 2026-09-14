import assert from "node:assert/strict";
import test from "node:test";
import { parseConsoleRoute } from "./routes.ts";

test("catalog detail routes retain opaque resource identity", () => {
  assert.deepEqual(parseConsoleRoute("#models/model-1"), { page: "models", resourceID: "model-1" });
  assert.deepEqual(parseConsoleRoute("#/templates/template-1"), {
    page: "templates",
    resourceID: "template-1",
  });
});

test("reference links decode each resource identity exactly once", () => {
  for (const page of ["models", "templates", "agents"] as const) {
    assert.deepEqual(parseConsoleRoute(`#${page}/resource%20one%252Ftwo`), { page, resourceID: "resource one%2Ftwo" });
    assert.deepEqual(parseConsoleRoute(`#${page}/%zz`), { page: "overview" });
  }
});

test("catalog revision routes retain the immutable revision identity", () => {
  assert.deepEqual(parseConsoleRoute("#models/model-1/revisions/model-revision-2"), { page: "overview" });
  assert.deepEqual(parseConsoleRoute("#/templates/template-1/revisions/3"), {
    page: "templates",
    resourceID: "template-1",
    revisionID: "3",
  });
});

test("malformed catalog revision routes fail closed", () => {
  assert.deepEqual(parseConsoleRoute("#models/model-1/revisions"), { page: "overview" });
  assert.deepEqual(parseConsoleRoute("#templates/template-1/history/2"), { page: "overview" });
  assert.deepEqual(parseConsoleRoute("#templates/template-1/revisions/latest"), { page: "overview" });
});

test("unknown and empty routes fail closed to overview", () => {
  assert.deepEqual(parseConsoleRoute("#system/audit"), { page: "overview" });
  assert.deepEqual(parseConsoleRoute(""), { page: "overview" });
});

test("provisioning is a first-class organization route", () => {
  assert.deepEqual(parseConsoleRoute("#provisioning"), { page: "provisioning" });
});

test("execution audit routes preserve opaque identities and retained-Agent filters", () => {
  assert.deepEqual(parseConsoleRoute("#audits"), { page: "audits" });
  assert.deepEqual(parseConsoleRoute("#audits?agent_id=Agent%2Fone%20%232"), { page: "audits", agentID: "Agent/one #2" });
  assert.deepEqual(parseConsoleRoute("#audits/run%2Fone%20%232"), { page: "audits", resourceID: "run/one #2" });
  assert.deepEqual(parseConsoleRoute("#audits/run%252Fone"), { page: "audits", resourceID: "run%2Fone" });
  for (const invalid of ["#audits/%zz", "#audits/run/extra", "#audits?agent_id=one&agent_id=two", "#audits?organization_id=other"]) {
    assert.deepEqual(parseConsoleRoute(invalid), { page: "overview" });
  }
});
