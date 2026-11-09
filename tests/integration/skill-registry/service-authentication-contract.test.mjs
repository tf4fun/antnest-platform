import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import commonIDs from "../../../contracts/common/ids.schema.json" with { type: "json" };
import commonError from "../../../contracts/common/error.schema.json" with { type: "json" };

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
  const categories = Object.fromEntries(
    read("../common/errors.json").errors.map(({ code, category }) => [
      code,
      category,
    ]),
  );
  const envelope = (code, retryable) => {
    const error = {
      code,
      category: categories[code],
      message: "Request rejected",
      retryable,
      request_id: "request-authentication-1",
    };
    return { ...error, error: { ...error } };
  };
  for (const file of [
    "registry-api.ids-v2.schema.json",
    "discovery-api.ids-v2.schema.json",
  ]) {
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    ajv.addSchema(commonIDs);
    ajv.addSchema(commonError);
    ajv.addSchema(read("registry-api.ids-v2.schema.json"));
    if (file !== "registry-api.ids-v2.schema.json") ajv.addSchema(read(file));
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
        validate(envelope(code, code === "identity_dependency_unavailable")),
        `${file}: ${code}: ${JSON.stringify(validate.errors)}`,
      );
    }
    assert(!validate(envelope("service_unauthenticated", true)));
  }
});
