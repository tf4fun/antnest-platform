import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const base = new URL("../../../contracts/skill-registry/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, base), "utf8"));

test("Registry route grants follow the frozen actual callers, not the old illustrative issue matrix", () => {
  const catalog = read("callers.json");
  const expected = {
    create: ["POST /internal/skills", ["admin-console"]],
    append: ["POST /internal/skills/{skill_id}/versions", ["admin-console"]],
    resolve: ["POST /internal/skill-versions/resolve", ["agent-controller"]],
    artifact: [
      "GET /internal/skills/{skill_id}/versions/{version}/artifact",
      ["admin-console", "runtime-controller"],
    ],
    "projection.update": [
      "PUT /internal/skill-projections",
      ["agent-acp-service"],
    ],
    promote: ["POST /internal/skill-projections/promote", ["admin-console"]],
    "discovery.search": [
      "POST /internal/skill-discovery/search",
      ["admin-console", "agent-acp-service"],
    ],
    "discovery.load": [
      "POST /internal/skill-discovery/load",
      ["admin-console", "agent-acp-service"],
    ],
  };
  for (const [name, [route, callers]] of Object.entries(expected)) {
    assert.deepEqual(catalog.routes[route].callers, callers, name);
    for (const caller of callers)
      assert.equal(
        catalog.routes[route].caller_context[caller],
        caller === "admin-console" ? "required" : "operation",
        name,
      );
  }
});

test("Registry error envelopes include bounded nonretryable authentication and scope errors", () => {
  for (const file of [
    "registry-api.schema.json",
    "discovery-api.schema.json",
  ]) {
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    ajv.addSchema(read("registry-api.schema.json"));
    if (file !== "registry-api.schema.json") ajv.addSchema(read(file));
    const validate = ajv.getSchema(`${read(file).$id}#/$defs/error`);
    for (const code of [
      "service_unauthenticated",
      "caller_not_allowed",
      "caller_context_required",
      "caller_context_invalid",
      "organization_mismatch",
      "actor_mismatch",
      "forbidden",
      "unsupported_media_type",
      "identity_dependency_unavailable",
    ]) {
      assert(
        validate({
          error: {
            code,
            message: "Request rejected",
            retryable: code === "identity_dependency_unavailable",
          },
        }),
        `${file}: ${code}`,
      );
    }
    assert(
      !validate({
        error: {
          code: "service_unauthenticated",
          message: "Request rejected",
          retryable: true,
        },
      }),
    );
  }
});
