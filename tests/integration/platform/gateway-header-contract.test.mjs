import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/edge-gateway/${name}`, import.meta.url),
      "utf8",
    ),
  );
const session = read("session-contract.json");
const headers = read("request-headers.json");
const sorted = (values) => [...values].sort();

test("session contract adopts the reserved namespace and browser input registry", () => {
  assert.equal(session.version, 18);
  assert.equal(session.header_boundary_contract, "request-headers.json");
  assert.deepEqual(headers.reserved_prefixes, ["X-Antnest-", "Antnest-"]);
  assert.deepEqual(session.browser_headers, headers.browser_headers);
  assert.deepEqual(sorted(session.browser_headers), [
    "X-Antnest-CSRF-Token",
    "X-Antnest-Expected-Principal",
  ]);
  assert.equal(headers.request_trailers, "discard");
});

test("trusted header projections contain current presentation hints only", () => {
  const hints = headers.headers
    .filter((entry) => entry.role === "presentation-hint")
    .map((entry) => entry.name);
  assert.deepEqual(sorted(session.trusted_headers), sorted(hints));
  assert.deepEqual(sorted(session.upstream_injected_headers), sorted(hints));
  for (const entry of headers.headers.filter(
    (entry) => entry.role !== "presentation-hint",
  )) {
    assert(
      !session.trusted_headers.includes(entry.name),
      `${entry.role} is not a presentation hint: ${entry.name}`,
    );
  }
});

test("route allowlists separate ordinary browser fields from server identity", () => {
  const registry = new Map(headers.headers.map((entry) => [entry.name, entry]));
  for (const [family, route] of Object.entries(headers.routes)) {
    const fields = headers.profiles[route.profile];
    assert(fields?.length, `missing profile for ${family}`);
    assert.equal(
      new Set(fields.map((field) => field.toLowerCase())).size,
      fields.length,
    );
    assert(
      fields.every((field) => !/^(?:x-)?antnest-/iu.test(field)),
      `${family} must not copy reserved browser headers`,
    );
    assert.equal(fields.includes("Authorization"), family === "scim");
    assert(!fields.includes("Cookie"));
    const anonymous = [
      "console-application",
      "workspace-assets",
      "scim",
    ].includes(family);
    assert.equal(route.caller_context, anonymous ? "none" : "required");
    if (anonymous) assert.deepEqual(route.hints, []);
    for (const name of route.hints)
      assert.equal(registry.get(name)?.role, "presentation-hint");
    if (route.validated_precondition) {
      assert.equal(family, "admin-network-policy");
      assert.equal(
        registry.get(route.validated_precondition)?.role,
        "validated-precondition",
      );
    }
  }
  assert.equal(
    headers.routes["admin-network-policy"].validated_precondition,
    "X-Antnest-Expected-Principal",
  );
});

test("declared WebSocket routes retain ACP protocols and signed caller authority", () => {
  assert.deepEqual(headers.websocket.routes, [
    "/api/app/agents/{agent_id}/acp",
    "/api/app/agents/{agent_id}/v1/acp",
    "/api/app/agents/{agent_id}/v2/acp",
  ]);
  assert.equal(headers.websocket.caller_context, "required");
  assert.deepEqual(headers.websocket.browser_fields, [
    "Sec-WebSocket-Protocol",
  ]);
  assert.equal(headers.websocket.hints.length, 3);
});
