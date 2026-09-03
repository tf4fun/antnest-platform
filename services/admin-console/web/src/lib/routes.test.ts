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

test("catalog revision routes retain the immutable revision identity", () => {
  assert.deepEqual(parseConsoleRoute("#models/model-1/revisions/model-revision-2"), {
    page: "models",
    resourceID: "model-1",
    revisionID: "model-revision-2",
  });
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
