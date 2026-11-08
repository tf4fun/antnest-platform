import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  listAuditsSchema,
  getAuditSchema,
  listAuditEventsSchema,
  auditListSchema,
  auditDetailSchema,
  auditEventsSchema,
} from "../src/domain/execution-audit.ts";
import { executionConfigurationSchema } from "../src/domain/execution-configuration.ts";
import {
  agentSettlementRequestSchema,
  agentSettlementResultSchema,
} from "../src/domain/agent-settlement.ts";
import {
  agentExecutionStateRequestSchema,
  agentExecutionStateSchema,
} from "../src/domain/agent-execution-state.ts";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Use --check or --write");
}
const contracts = [
  {
    name: "list-execution-audits-request",
    definition: listAuditsSchema,
    title: "Administrative audit list request",
    description:
      "Organization and role derive from verified Identity-signed caller context and Console workload, never from this body.",
  },
  {
    name: "get-execution-audit-request",
    definition: getAuditSchema,
    title: "Administrative audit detail request",
    description: "Selects one Run within the verified administrator organization.",
  },
  {
    name: "list-execution-events-request",
    definition: listAuditEventsSchema,
    title: "Administrative audit event request",
    description: "Execution messages and permission records use separate cursors and ordering.",
  },
  {
    name: "execution-audit-list",
    definition: auditListSchema,
    title: "Administrative audit list",
    description: "Current persisted Run summaries, including retained historical Agents.",
  },
  {
    name: "execution-audit",
    definition: auditDetailSchema,
    title: "Administrative execution audit",
    description:
      "Original input and non-secret execution facts. Usage measurements are per model request, not cumulative Session cost.",
  },
  {
    name: "execution-audit-events",
    definition: auditEventsSchema,
    title: "Administrative execution records",
    description:
      "Normalized message payloads or current permission records; no fabricated cross-store sequence.",
  },
  {
    name: "agent-execution-state-request",
    definition: agentExecutionStateRequestSchema,
    title: "Workspace execution state request",
    description:
      "The trusted transport tuple selects the Agent and caller; the request has no identity parameters.",
  },
  {
    name: "agent-execution-state",
    definition: agentExecutionStateSchema,
    title: "Workspace execution state",
    description:
      "Current view only, not an admission or execution result. Denied views disclose neither configuration nor Session identity.",
  },
  {
    name: "execution-snapshot",
    definition: executionConfigurationSchema,
    title: "Organization execution configuration",
    description:
      "Structural contract. Apply also validates unique identifiers, references and accepting-Agent readiness; see execution-api.md.",
  },
  {
    name: "settle-agent-request",
    definition: agentSettlementRequestSchema,
    title: "Agent lifecycle settlement request",
    description:
      "Agent-level operation with a fixed lifecycle deadline, not a Run admission or reservation.",
  },
  {
    name: "settle-agent-result",
    definition: agentSettlementResultSchema,
    title: "Agent lifecycle settlement result",
    description:
      "Local quiescence alone does not prove Runtime foreground calls stopped; see execution-api.md.",
  },
];

// The discovery observation is shared with Controller. Retain its closed union
// and cross-field constraints that Zod refinements cannot serialize to JSON Schema.
const providerLimits = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/agent-controller/provider-token-limits.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function inlineProviderLimits(value) {
  if (Array.isArray(value)) return value.map(inlineProviderLimits);
  if (value === null || typeof value !== "object") return value;
  if (value.$ref) {
    if (!value.$ref.startsWith("#/$defs/"))
      throw new Error("Provider limits must be self-contained");
    const definition = providerLimits.$defs[value.$ref.split("/").at(-1)];
    if (definition === undefined) throw new Error("Provider limit definition is missing");
    return inlineProviderLimits(definition);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["$schema", "$id", "$defs", "title"].includes(key))
      .map(([key, item]) => [key, inlineProviderLimits(item)]),
  );
}
const IDS_V2 = new Set([
  "agent-execution-state",
  "execution-audit",
  "execution-audit-list",
  "execution-snapshot",
  "list-execution-audits-request",
  "settle-agent-request",
]);
const SCOPED_ID_PROPERTIES = {
  organization_id: "organizationId",
  organizationId: "organizationId",
  agent_id: "agentId",
  agentId: "agentId",
  requesting_agent_id: "agentId",
  source_agent_id: "agentId",
  target_agent_id: "agentId",
  user_id: "userId",
  userId: "userId",
  owner_id: "userId",
  actor_id: "userId",
  actor_principal_id: "userId",
  principal_id: "userId",
  principalId: "userId",
  owner_principal_id: "userId",
};
const SCOPED_ID_ITEM_PROPERTIES = { principal_ids: "userId", owner_principal_ids: "userId" };
const scopedIdRef = (kind) => ({ $ref: `../common/ids.schema.json#/$defs/${kind}` });
function scopeSharedIds(value) {
  if (Array.isArray(value)) return value.map(scopeSharedIds);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "properties" && item !== null && typeof item === "object" && !Array.isArray(item))
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([name, sub]) => {
              if (
                SCOPED_ID_PROPERTIES[name] !== undefined &&
                sub !== null &&
                typeof sub === "object" &&
                !Array.isArray(sub)
              )
                return [name, scopedIdRef(SCOPED_ID_PROPERTIES[name])];
              if (
                SCOPED_ID_ITEM_PROPERTIES[name] !== undefined &&
                sub !== null &&
                typeof sub === "object" &&
                !Array.isArray(sub) &&
                sub.type === "array"
              )
                return [name, { ...sub, items: scopedIdRef(SCOPED_ID_ITEM_PROPERTIES[name]) }];
              return [name, scopeSharedIds(sub)];
            }),
          ),
        ];
      return [key, scopeSharedIds(item)];
    }),
  );
}
for (const contract of contracts) {
  const idsV2 = IDS_V2.has(contract.name);
  const destination = new URL(
    `../../../contracts/agent-acp/${contract.name}${idsV2 ? ".ids-v2" : ""}.schema.json`,
    import.meta.url,
  );
  let schema = z.toJSONSchema(contract.definition, {
    target: "draft-2020-12",
    io: contract.name.endsWith("-request") ? "input" : "output",
  });
  schema.$id = `https://schemas.antnest.dev/agent-acp/${contract.name}${idsV2 ? ".ids-v2" : ""}.schema.json`;
  schema.title = contract.title;
  schema.description = contract.description;
  const withSharedPagination = (properties, field, fragment) => {
    properties[field] = {
      allOf: [{ $ref: `../common/pagination.schema.json#/$defs/${fragment}` }],
      ...properties[field],
    };
  };
  if (contract.name === "list-execution-audits-request") {
    withSharedPagination(schema.properties, "cursor", "cursor");
    withSharedPagination(schema.properties, "limit", "limit");
  }
  if (contract.name === "execution-audit-list")
    withSharedPagination(schema.properties, "next_cursor", "nullable_cursor");
  if (contract.name === "execution-audit-events")
    for (const branch of schema.oneOf)
      withSharedPagination(branch.properties, "next_cursor", "nullable_cursor");
  if (contract.name === "list-execution-events-request")
    withSharedPagination(schema.properties, "cursor", "cursor");
  if (contract.name === "execution-snapshot") {
    schema.$defs = { ...schema.$defs, provider_token_limits: inlineProviderLimits(providerLimits) };
    schema.properties.models.items.properties.provider_token_limits = {
      $ref: "#/$defs/provider_token_limits",
    };
  }
  if (idsV2) schema = scopeSharedIds(schema);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  if (mode === "--write") {
    await writeFile(destination, expected);
  } else if ((await readFile(destination, "utf8")) !== expected) {
    throw new Error(`${contract.name} schema is stale; regenerate it with --write`);
  }
}
