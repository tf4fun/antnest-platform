import { z } from "zod";
import { DomainError } from "./errors.js";

export const authorizationModeSchema = z.enum(["auto", "approve", "smart_approve", "chat"]);
export type AuthorizationMode = z.infer<typeof authorizationModeSchema>;
export const toolRuleSchema = z
  .object({
    source: z.enum(["runtime", "agent"]),
    sourceId: z.string().min(1),
    toolName: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
  })
  .strict();
export const authorizationSchema = z
  .object({ mode: authorizationModeSchema, toolRules: z.array(toolRuleSchema).max(256) })
  .strict();
export type Authorization = z.infer<typeof authorizationSchema>;
export const sessionConfigurationSchema = z
  .object({
    modelProfileId: z.string().min(1).optional(),
    authorizationMode: authorizationModeSchema.optional(),
    toolRules: z.array(toolRuleSchema).max(128).optional(),
  })
  .strict();
export type SessionConfiguration = z.infer<typeof sessionConfigurationSchema>;
export const admittedConfigurationSchema = z
  .object({
    modelProfileId: z.string().min(1),
    modelProfileRevisionId: z.string().min(1),
    authorization: authorizationSchema,
    authorizationRevision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type AdmittedConfiguration = z.infer<typeof admittedConfigurationSchema>;
export type SessionModel = {
  modelProfileId: string;
  revisionId: string;
  displayName: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
};
export type ConfigurationCatalog = {
  models: SessionModel[];
  defaultModel: SessionModel & { available: boolean };
  defaultAuthorization: Authorization;
  authorizationRevision: number;
};
export type ConfigurationChoice = { id: string; name: string; description?: string };
export type SessionConfigurationView = {
  modelId: string;
  modeId: AuthorizationMode;
  modeValue: string;
  defaultModeId: AuthorizationMode;
  models: ConfigurationChoice[];
};
export const authorizationModes: ConfigurationChoice[] = [
  { id: "auto", name: "Auto", description: "Run tools automatically." },
  {
    id: "approve",
    name: "Approve",
    description: "Require permission for tools without an explicit rule.",
  },
  {
    id: "smart_approve",
    name: "Smart Approve",
    description: "Use tool rules and require permission when safety is not established.",
  },
  { id: "chat", name: "Chat", description: "Respond without calling tools." },
];

export function configurationView(
  configuration: SessionConfiguration,
  catalog: ConfigurationCatalog,
): SessionConfigurationView {
  const modelId =
    configuration.modelProfileId === undefined
      ? "agent_default"
      : `profile:${configuration.modelProfileId}`;
  const models = [
    {
      id: "agent_default",
      name: `Agent default: ${catalog.defaultModel.displayName}${catalog.defaultModel.available ? "" : " (Unavailable)"}`,
    },
    ...catalog.models.map((model) => ({
      id: `profile:${model.modelProfileId}`,
      name: model.displayName,
      description: model.model,
    })),
  ];
  if (!models.some((model) => model.id === modelId))
    models.push({ id: modelId, name: "Unavailable selected model" });
  return {
    modelId,
    models,
    modeId: configuration.authorizationMode ?? catalog.defaultAuthorization.mode,
    modeValue: configuration.authorizationMode ?? "agent_default",
    defaultModeId: catalog.defaultAuthorization.mode,
  };
}

export function changeConfiguration(
  current: SessionConfiguration,
  id: string,
  value: string | boolean,
  catalog: ConfigurationCatalog,
): SessionConfiguration {
  if (typeof value !== "string")
    throw new DomainError("invalid_configuration", "This option requires a select value");
  const next = structuredClone(current);
  if (id === "model") {
    if (value === "agent_default") delete next.modelProfileId;
    else {
      const model = catalog.models.find((item) => `profile:${item.modelProfileId}` === value);
      if (model === undefined)
        throw new DomainError(
          "model_unavailable",
          "Selected model is not available in this organization",
        );
      next.modelProfileId = model.modelProfileId;
    }
  } else if (id === "mode") {
    if (value === "agent_default") delete next.authorizationMode;
    else {
      const mode = authorizationModeSchema.safeParse(value);
      if (!mode.success)
        throw new DomainError("invalid_configuration", "Unknown authorization mode");
      next.authorizationMode = mode.data;
    }
  } else throw new DomainError("invalid_configuration", "Unknown Session configuration option");
  return next;
}

export function toolPermission(
  authorization: Authorization,
  tool: {
    source: string;
    sourceId: string;
    name: string;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  },
): "allow" | "deny" | "ask" {
  if (authorization.mode === "chat") return "deny";
  if (authorization.mode === "auto") return "allow";
  const explicit = authorization.toolRules.find(
    (rule) =>
      rule.source === tool.source && rule.sourceId === tool.sourceId && rule.toolName === tool.name,
  )?.decision;
  if (explicit !== undefined) return explicit;
  if (
    authorization.mode === "smart_approve" &&
    tool.source !== "client" &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint !== true
  )
    return "allow";
  return "ask";
}
