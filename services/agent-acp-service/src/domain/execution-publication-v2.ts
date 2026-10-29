import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DomainError } from "./errors.js";
import {
  executionModelSchema,
  parseExecutionConfiguration,
  privateAgentConfigurationSchema,
  providerFieldsSchema,
  validateConfiguration,
  type ExecutionConfiguration,
} from "./execution-configuration.js";
import { organizationBudgetSchema } from "./model-budget.js";

const identifier = z.string().min(1).max(200);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digestHex = z.string().regex(/^[0-9a-f]{64}$/u);

export const providerConfigurationV2CredentialSchema = z.strictObject({
  ref: identifier,
  version: identifier,
});

export const providerConfigurationV2Schema = z.union([
  z.strictObject({
    ...providerFieldsSchema,
    enabled: z.literal(true),
    credential_revision: identifier,
    credential: providerConfigurationV2CredentialSchema,
  }),
  z.strictObject({
    ...providerFieldsSchema,
    enabled: z.literal(false),
    credential_revision: identifier,
    credential: providerConfigurationV2CredentialSchema,
  }),
  z.strictObject({ ...providerFieldsSchema, enabled: z.literal(false) }),
]);

export const executionConfigurationV2Schema = z.strictObject({
  organization_id: identifier,
  schema_version: z.literal(2),
  revision,
  organization_budget: organizationBudgetSchema.optional(),
  providers: z.array(providerConfigurationV2Schema),
  models: z.array(executionModelSchema),
  agents: z.array(privateAgentConfigurationSchema),
});

export type ProviderConfigurationV2 = z.infer<typeof providerConfigurationV2Schema>;
export type ExecutionConfigurationV2 = z.infer<typeof executionConfigurationV2Schema>;
export type ExecutionCredentialReference = z.infer<typeof providerConfigurationV2CredentialSchema>;

const collectionDelta = <T extends z.ZodType>(upserts: T) =>
  z.strictObject({ upserts: z.array(upserts), deletes: z.array(identifier) });

export const executionDeltaSchema = z.strictObject({
  schema_version: z.literal(2),
  organization_id: identifier,
  base_revision: revision,
  revision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  providers: collectionDelta(providerConfigurationV2Schema),
  models: collectionDelta(executionModelSchema),
  agents: collectionDelta(privateAgentConfigurationSchema),
  organization_budget: organizationBudgetSchema.nullable(),
});

export type ExecutionDelta = z.infer<typeof executionDeltaSchema>;

export const executionDigestRequestSchema = z.strictObject({ organization_id: identifier });

const digestEntrySchema = z.strictObject({ id: identifier, digest: digestHex });

export const executionDigestResponseSchema = z
  .strictObject({
    organization_id: identifier,
    schema_version: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    digest: digestHex.nullable(),
    providers: z.array(digestEntrySchema),
    models: z.array(digestEntrySchema),
    agents: z.array(digestEntrySchema),
    organization_budget_digest: digestHex.nullable(),
  })
  .superRefine((response, ctx) => {
    const collections = [response.providers, response.models, response.agents];
    if (response.schema_version === 0) {
      if (
        response.revision !== 0 ||
        response.digest !== null ||
        response.organization_budget_digest !== null ||
        collections.some((collection) => collection.length !== 0)
      )
        ctx.addIssue({ code: "custom", message: "Absent digest must be empty" });
      return;
    }
    if (response.revision < 1 || response.digest === null)
      ctx.addIssue({ code: "custom", message: "Present digest requires revision and digest" });
    for (const collection of collections) {
      const ids = collection.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "Duplicate digest identifier" });
    }
  });

export type ExecutionDigestResponse = z.infer<typeof executionDigestResponseSchema>;

export function parseExecutionDelta(input: unknown): ExecutionDelta {
  const parsed = executionDeltaSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("invalid_execution_configuration", "Invalid execution delta");
  if (parsed.data.revision <= parsed.data.base_revision)
    throw new DomainError("invalid_execution_configuration", "Delta revision must exceed base");
  const collections: { upserts: { [key: string]: unknown }[]; deletes: string[]; key: string }[] = [
    {
      upserts: parsed.data.providers.upserts,
      deletes: parsed.data.providers.deletes,
      key: "connection_id",
    },
    {
      upserts: parsed.data.models.upserts,
      deletes: parsed.data.models.deletes,
      key: "model_profile_id",
    },
    { upserts: parsed.data.agents.upserts, deletes: parsed.data.agents.deletes, key: "agent_id" },
  ];
  for (const collection of collections) {
    const upserted = new Set<string>();
    for (const document of collection.upserts) {
      const id = document[collection.key] as string;
      if (upserted.has(id))
        throw new DomainError("invalid_execution_configuration", "Duplicate delta document");
      upserted.add(id);
    }
    const removed = new Set<string>();
    for (const id of collection.deletes) {
      if (upserted.has(id) || removed.has(id))
        throw new DomainError(
          "invalid_execution_configuration",
          "Delta identifier is duplicated or overlaps",
        );
      removed.add(id);
    }
  }
  return parsed.data;
}

export function parseExecutionConfigurationV2(input: unknown): ExecutionConfigurationV2 {
  const parsed = executionConfigurationV2Schema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("invalid_execution_configuration", "Invalid execution configuration");
  for (const provider of parsed.data.providers) {
    if (
      "credential" in provider &&
      (provider.credential.ref !== provider.connection_id ||
        provider.credential.version !== provider.credential_revision)
    )
      throw new DomainError(
        "invalid_execution_configuration",
        "Provider credential reference does not match the connection",
      );
  }
  return validateConfiguration(parsed.data);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) throw new TypeError("Digest input is not JSON");
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function canonicalExecutionJSON(document: Record<string, unknown>): string {
  return canonical(document);
}

function documentDigest(document: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(document), "utf8").digest("hex");
}

export function publicDocumentDigest(
  document: unknown,
  strip: (object: Record<string, unknown>) => void,
): string {
  const object = structuredClone(document) as Record<string, unknown>;
  strip(object);
  return documentDigest(object);
}

export type ExecutionDocumentDigests = {
  providers: Map<string, string>;
  models: Map<string, string>;
  agents: Map<string, string>;
  organizationBudget: string | null;
};

export function publicExecutionDigests(snapshot: {
  organization_id: string;
  organization_budget?: unknown;
  providers: { connection_id: string }[];
  models: { model_profile_id: string }[];
  agents: { agent_id: string }[];
}): ExecutionDocumentDigests {
  const providers = new Map<string, string>();
  for (const provider of snapshot.providers) {
    providers.set(
      provider.connection_id,
      publicDocumentDigest(provider, (object) => {
        delete object.credential;
      }),
    );
  }
  const models = new Map<string, string>();
  for (const model of snapshot.models) {
    models.set(
      model.model_profile_id,
      publicDocumentDigest(model, () => {}),
    );
  }
  const agents = new Map<string, string>();
  for (const agent of snapshot.agents) {
    agents.set(
      agent.agent_id,
      publicDocumentDigest(agent, (object) => {
        const runtime = object.runtime;
        if (runtime !== null && typeof runtime === "object") {
          delete (runtime as Record<string, unknown>).credential;
        }
        const ids = object.principal_ids;
        if (Array.isArray(ids)) {
          object.principal_ids = [...(ids as string[])].sort();
        }
      }),
    );
  }
  return {
    providers,
    models,
    agents,
    organizationBudget:
      snapshot.organization_budget === undefined
        ? null
        : documentDigest(snapshot.organization_budget as Record<string, unknown>),
  };
}

function sortedEntries(digests: Map<string, string>): { id: string; digest: string }[] {
  return [...digests.entries()]
    .sort(([left], [right]) => (left < right ? -1 : Number(left > right)))
    .map(([id, digest]) => ({ id, digest }));
}

export function executionDigestResponse(snapshot: {
  organization_id: string;
  schema_version: number;
  revision: number;
  organization_budget?: unknown;
  providers: { connection_id: string }[];
  models: { model_profile_id: string }[];
  agents: { agent_id: string }[];
}): ExecutionDigestResponse {
  const documents = publicExecutionDigests(snapshot);
  const providers = sortedEntries(documents.providers);
  const models = sortedEntries(documents.models);
  const agents = sortedEntries(documents.agents);
  const root = documentDigest({
    organization_id: snapshot.organization_id,
    schema_version: snapshot.schema_version,
    revision: snapshot.revision,
    providers,
    models,
    agents,
    organization_budget_digest: documents.organizationBudget,
  });
  return Object.freeze({
    organization_id: snapshot.organization_id,
    schema_version: snapshot.schema_version as 0 | 1 | 2,
    revision: snapshot.revision,
    digest: root,
    providers,
    models,
    agents,
    organization_budget_digest: documents.organizationBudget,
  });
}

export function absentExecutionDigest(organizationId: string): ExecutionDigestResponse {
  return Object.freeze({
    organization_id: organizationId,
    schema_version: 0,
    revision: 0,
    digest: null,
    providers: [],
    models: [],
    agents: [],
    organization_budget_digest: null,
  });
}

export function parseExecutionAuthority(input: unknown): ExecutionConfiguration {
  if (
    input !== null &&
    typeof input === "object" &&
    (input as Record<string, unknown>).schema_version !== undefined
  ) {
    if ((input as Record<string, unknown>).schema_version !== 2)
      throw new DomainError("invalid_execution_configuration", "Unsupported schema_version");
    return parseExecutionConfigurationV2(input);
  }
  return parseExecutionConfiguration(input);
}

export function reconstructExecutionDelta(
  current: ExecutionConfigurationV2,
  delta: ExecutionDelta,
): ExecutionConfigurationV2 {
  const mergeCollection = <T>(
    documents: T[],
    changes: { upserts: T[]; deletes: string[] },
    key: (document: T) => string,
  ): T[] => {
    const upserts = new Map(changes.upserts.map((document) => [key(document), document]));
    const removed = new Set(changes.deletes);
    const retained = documents.filter((document) => !removed.has(key(document)));
    const merged = retained.map((document) => upserts.get(key(document)) ?? document);
    const present = new Set(retained.map(key));
    for (const document of changes.upserts) {
      if (!present.has(key(document))) merged.push(document);
    }
    return merged;
  };
  const rebuilt = {
    organization_id: delta.organization_id,
    schema_version: 2 as const,
    revision: delta.revision,
    providers: mergeCollection(
      current.providers,
      delta.providers,
      (document) => document.connection_id,
    ),
    models: mergeCollection(current.models, delta.models, (document) => document.model_profile_id),
    agents: mergeCollection(current.agents, delta.agents, (document) => document.agent_id),
    ...(delta.organization_budget === null
      ? {}
      : { organization_budget: delta.organization_budget }),
  };
  return parseExecutionConfigurationV2(rebuilt);
}

function upgradeComparable(configuration: ExecutionConfiguration): Record<string, unknown> {
  const copy = structuredClone(configuration) as Record<string, unknown>;
  delete copy.schema_version;
  for (const provider of copy.providers as Record<string, unknown>[]) {
    delete provider.credential;
  }
  return copy;
}

export function allowsV1ToV2Upgrade(
  previous: ExecutionConfiguration,
  incoming: ExecutionConfiguration,
): boolean {
  if ("schema_version" in previous) return false;
  if (!("schema_version" in incoming)) return false;
  return isDeepStrictEqual(upgradeComparable(previous), upgradeComparable(incoming));
}
