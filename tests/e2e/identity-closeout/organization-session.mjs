import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/edge-gateway/session-response.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const compiler = new Ajv2020({ strict: true, validateFormats: false });
const validators = Object.fromEntries(
  ["login", "session"].map((name) => [
    name,
    compiler.compile({
      $schema: schema.$schema,
      $defs: schema.$defs,
      $ref: `#/$defs/${name}`,
    }),
  ]),
);

export function assertOrganizationSession(
  payload,
  kind,
  organization = { slug: "stage3", name: "Stage 3" },
) {
  assert(
    validators[kind]?.(payload),
    `Gateway ${kind} response violates the central session schema`,
  );
  assert.equal(
    payload.principal.organization_slug,
    organization.slug,
    "Gateway projected the wrong Organization slug",
  );
  assert.equal(
    payload.principal.organization_name,
    organization.name,
    "Gateway projected the wrong Organization name",
  );
  return payload.principal;
}
