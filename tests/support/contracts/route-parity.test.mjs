import assert from "node:assert/strict";
import test from "node:test";
import {
  collectContractRoutes,
  routeBodyProblems,
  routeParityProblems,
} from "./route-parity.mjs";

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

test("routeBodyProblems accepts declared request bodies and response maps", () => {
  assert.deepEqual(
    routeBodyProblems([
      {
        method: "POST",
        path: "/internal/skill-maintenance/{action}",
        request_body:
          "runtime/skill-maintenance.schema.json#/$defs/digest_request",
        responses: {
          200: {
            body: "runtime/skill-maintenance.schema.json#/$defs/maintenance_receipt",
          },
          400: { body: "common/error.schema.json" },
        },
        errors: [
          { code: "invalid_request", status: 400 },
          { code: "maintenance_unauthorized", status: 401 },
        ],
      },
      {
        method: "GET",
        path: "/status",
        request_body: "none",
        responses: {
          200: { body: "egress/control-response.schema.json#/$defs/status" },
        },
      },
      {
        method: "GET",
        path: "/mcp",
        request_schema: "runtime/http.schema.json#/$defs/protocol_request",
        responses: {
          200: {
            body: "runtime/http.schema.json#/$defs/protocol_response",
            content_type: "text/event-stream",
          },
        },
      },
      {
        method: "PUT",
        path: "/internal/agent-networks/{agent_id}",
        request_body: "none",
        responses: {
          200: { body: "egress/control-response.schema.json#/$defs/network" },
          503: {
            body: "common/error.schema.json",
            content_type: "application/json",
          },
        },
      },
    ]),
    [],
  );
});

test("routeBodyProblems does not forbid a declared body on GET routes", () => {
  assert.deepEqual(
    routeBodyProblems([
      {
        method: "GET",
        path: "/observe",
        request_body: "runtime/http.schema.json#/$defs/protocol_request",
        responses: {
          200: {
            body: "runtime/http.schema.json#/$defs/protocol_response",
            content_type: "text/event-stream",
          },
        },
      },
      {
        method: "POST",
        path: "/release",
        request_body: "none",
        responses: { 204: { body: "none" } },
      },
    ]),
    [],
  );
});

test("routeBodyProblems requires a request body declaration", () => {
  assert.deepEqual(
    routeBodyProblems([
      {
        method: "PUT",
        path: "/a",
        responses: { 200: { body: "none" } },
      },
    ]),
    ["route PUT /a: missing request body declaration"],
  );
});

test("routeBodyProblems falls back to the legacy request_schema field", () => {
  assert.deepEqual(
    routeBodyProblems([
      {
        method: "PUT",
        path: "/a",
        request_schema: "egress/policy-revision-request.schema.json",
        responses: { 200: { body: "none" } },
      },
    ]),
    [],
  );
});

test("routeBodyProblems rejects malformed request body references", () => {
  for (const request_body of ["", 5, null, {}, []]) {
    const problems = routeBodyProblems([
      {
        method: "PUT",
        path: "/a",
        request_body,
        responses: { 200: { body: "none" } },
      },
    ]);
    assert.deepEqual(problems, [
      "route PUT /a: invalid request body reference",
    ]);
  }
});

test("routeBodyProblems requires a non-empty responses map", () => {
  for (const responses of [undefined, {}, [], "200", null]) {
    const problems = routeBodyProblems([
      { method: "GET", path: "/a", request_body: "none", responses },
    ]);
    assert.deepEqual(problems, ["route GET /a: missing responses"]);
  }
});

test("routeBodyProblems rejects invalid response statuses", () => {
  for (const status of ["abc", "99", "600", "20x", "200.5", ""]) {
    const problems = routeBodyProblems([
      {
        method: "GET",
        path: "/a",
        request_body: "none",
        responses: { [status]: { body: "none" }, 200: { body: "none" } },
      },
    ]);
    assert.deepEqual(problems, [
      `route GET /a: invalid response status ${JSON.stringify(status)}`,
    ]);
  }
});

test("routeBodyProblems rejects malformed response bodies", () => {
  for (const entry of [
    "none",
    {},
    { body: "" },
    { body: 7 },
    { body: null },
    { body: "none", content_type: 5 },
    { body: "none", extra: true },
  ]) {
    const problems = routeBodyProblems([
      {
        method: "GET",
        path: "/a",
        request_body: "none",
        responses: { 200: entry },
      },
    ]);
    assert.deepEqual(problems, [
      "route GET /a: invalid response body for status 200",
    ]);
  }
});

test("routeBodyProblems flags duplicate method and path pairs once", () => {
  assert.deepEqual(
    routeBodyProblems([
      {
        method: "GET",
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
      {
        method: "get",
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
      {
        method: "GET",
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
      {
        method: "GET",
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
      {
        method: "POST",
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
    ]),
    ["duplicate route: GET /a", "duplicate route: GET /a"],
  );
});

test("routeBodyProblems rejects invalid error entries", () => {
  for (const errors of [
    "conflict",
    [null],
    [{}],
    [{ code: 409, status: 409 }],
    [{ code: "", status: 409 }],
    [{ status: 409 }],
    [{ code: "conflict" }],
    [{ code: "conflict", status: "409" }],
    [{ code: "conflict", status: 40.9 }],
    [{ code: "conflict", status: 0 }],
    [{ code: "conflict", status: 600 }],
    [{ code: "conflict", status: 409, extra: 1 }],
  ]) {
    const problems = routeBodyProblems([
      {
        method: "PUT",
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
        errors,
      },
    ]);
    assert.equal(problems.length, 1, JSON.stringify(errors));
    assert.ok(
      problems[0].startsWith("route PUT /a: invalid error"),
      problems[0],
    );
  }
});

test("routeBodyProblems reports malformed route entries", () => {
  assert.deepEqual(
    routeBodyProblems([
      "GET /a",
      {
        path: "/a",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
      {
        method: "GET",
        request_body: "none",
        responses: { 200: { body: "none" } },
      },
    ]),
    [
      "route route[0]: route must declare method and path",
      "route route[1]: route must declare method and path",
      "route route[2]: route must declare method and path",
    ],
  );
});

test("routeBodyProblems sorts every diagnostic deterministically", () => {
  const problems = routeBodyProblems([
    { method: "PUT", path: "/b" },
    { method: "GET", path: "/a" },
    { method: "PUT", path: "/b" },
  ]);
  assert.deepEqual(problems, [...problems].sort());
});
