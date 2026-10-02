import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { workspaceFromBridgeBootstrap } from "../../../services/agent-ui/web/src/lib/bootstrap.ts";
import { assertSecretFree } from "./evidence.mjs";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/agent-ui/workspace-api.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validBootstrap = new Ajv2020({
  strict: true,
  validateFormats: false,
}).compile({
  $schema: schema.$schema,
  $defs: schema.$defs,
  $ref: "#/$defs/bootstrap",
});

// Validate the actual wire value, then hand that same value to the production
// frontend decoder. Expected display values come from the Identity row oracle.
export function assertWorkspaceBootstrap(
  payload,
  principal,
  organization,
  agentIDs,
  secrets = [],
) {
  assertSecretFree(JSON.stringify(payload), secrets);
  assert(validBootstrap(payload), "Node bootstrap violates the central schema");
  assert.deepEqual(
    payload.principal,
    {
      userId: principal.user_id,
      organizationId: principal.organization_id,
      organizationSlug: organization.slug,
      organizationName: organization.name,
      administrator:
        principal.system_role === "admin" ||
        principal.organization_role === "admin",
    },
    "Node bootstrap changed the verified Organization or authorization scope",
  );
  assert.deepEqual(
    payload.agents.map((agent) => agent.agentId).sort(),
    [...agentIDs].sort(),
    "Workspace directory crossed Organization or owner scope",
  );
  const workspace = workspaceFromBridgeBootstrap(payload);
  assert.equal(workspace.principal.organizationName, organization.name);
  assert.equal(workspace.principal.organizationSlug, organization.slug);
  return workspace;
}

export function assertWorkspaceDocument(
  html,
  principal,
  organization,
  agentIDs,
  secrets = [],
) {
  assertSecretFree(html, secrets);
  assert(
    !html.includes('data-ssr="fallback"'),
    "SSR silently used a fallback shell",
  );
  assert(
    !html.includes("Organization workspace"),
    "Successful SSR retained the placeholder",
  );
  const embedded = html.match(/id="workspace-bootstrap"[^>]*>(.*?)<\/script>/s);
  assert(embedded, "SSR omitted the hydration bootstrap");
  let input;
  try {
    input = JSON.parse(embedded[1]);
  } catch {
    throw new Error("SSR bootstrap is not safe JSON");
  }
  assertWorkspaceBootstrap(
    input.bootstrap,
    principal,
    organization,
    agentIDs,
    secrets,
  );
  return input;
}
