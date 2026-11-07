import assert from "node:assert/strict";
import test from "node:test";
import { collectContractRoutes, routeParityProblems } from "./route-parity.mjs";

test("collectContractRoutes gathers nested arrays and objects, sorted and deduplicated", () => {
  const document = {
    methods: [
      { method: "GET", path: "/a" },
      { method: "POST", path: "/b" },
      [{ method: "GET", path: "/c" }],
    ],
    nested: { deep: { method: "DELETE", path: "/d" } },
    ignored: { method: 3, path: "/x" },
    alsoIgnored: { method: "GET" },
    duplicate: [{ method: "GET", path: "/a" }],
  };
  assert.deepEqual(collectContractRoutes(document), [
    "DELETE /d",
    "GET /a",
    "GET /c",
    "POST /b",
  ]);
});

test("collectContractRoutes prepends a supplied base path", () => {
  const subtree = {
    methods: [{ method: "GET", path: "/rpc/identity/resolve" }],
  };
  assert.deepEqual(collectContractRoutes(subtree, "/internal/identity/"), [
    "GET /internal/identity/rpc/identity/resolve",
  ]);
});

test("routeParityProblems returns empty for identical inventories", () => {
  assert.deepEqual(
    routeParityProblems(["GET /a", "POST /b"], ["POST /b", "GET /a"]),
    [],
  );
});

test("routeParityProblems reports both directions sorted", () => {
  assert.deepEqual(
    routeParityProblems(
      ["GET /a", "POST /b", "DELETE /d"],
      ["GET /a", "POST /b", "PUT /e"],
    ),
    [
      "contract route is not registered: DELETE /d",
      "registered route has no contract: PUT /e",
    ],
  );
});

test("routeParityProblems flags method mismatch on both sides", () => {
  assert.deepEqual(routeParityProblems(["GET /a"], ["POST /a"]), [
    "contract route is not registered: GET /a",
    "registered route has no contract: POST /a",
  ]);
});
