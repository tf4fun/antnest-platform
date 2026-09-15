import { z } from "zod";
import { DomainError } from "./errors.js";
import { thinkingEffortSchema, type ThinkingEffort } from "./model-thinking.js";

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
    thinkingEffort: thinkingEffortSchema.optional(),
    authorizationMode: authorizationModeSchema.optional(),
    toolRules: z.array(toolRuleSchema).max(128).optional(),
  })
  .strict();
export type SessionConfiguration = z.infer<typeof sessionConfigurationSchema>;
export const admittedConfigurationSchema = z
  .object({
    modelProfileId: z.string().min(1),
    authorization: authorizationSchema,
    authorizationRevision: z.number().int().positive(),
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type AdmittedConfiguration = z.infer<typeof admittedConfigurationSchema>;
export type SessionModel = {
  modelProfileId: string;
  displayName: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  providerName?: string;
  thinkingEfforts?: readonly ThinkingEffort[];
};
export type ConfigurationCatalog = {
  models: SessionModel[];
  defaultModel: SessionModel & { available: boolean };
  fallbackModels?: SessionModel[];
  unavailableModelProfileIds?: string[];
  defaultAuthorization: Authorization;
  authorizationRevision: number;
};
export type ConfigurationChoice = {
  id: string;
  name: string;
  description?: string;
  providerName?: string;
};
export type SessionConfigurationView = {
  notice?: string;
  modelId: string;
  modeId: AuthorizationMode;
  modeValue: string;
  defaultModeId: AuthorizationMode;
  models: ConfigurationChoice[];
  thinking?: { currentValue: string; options: ConfigurationChoice[] };
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
  const effective = selectSessionModel(configuration, catalog);
  const automatic = selectSessionModel({}, catalog);
  const preferred = configuration.modelProfileId ?? catalog.defaultModel.modelProfileId;
  const fallback = effective !== undefined && effective.modelProfileId !== preferred;
  const modelId =
    configuration.modelProfileId === undefined || fallback
      ? "agent_default"
      : `profile:${configuration.modelProfileId}`;
  const models = [
    {
      id: "agent_default",
      name: `Agent default: ${automatic?.displayName ?? catalog.defaultModel.displayName}${automatic === undefined ? " (Unavailable)" : ""}`,
    },
    ...catalog.models.map((model) => ({
      id: `profile:${model.modelProfileId}`,
      name: model.displayName,
      description: model.model,
      ...(model.providerName === undefined ? {} : { providerName: model.providerName }),
    })),
  ];
  if (!models.some((model) => model.id === modelId))
    models.push({ id: modelId, name: "Unavailable selected model" });
  const normalized =
    fallback && !effective.thinkingEfforts?.includes(configuration.thinkingEffort!)
      ? { ...configuration, thinkingEffort: undefined }
      : configuration;
  const thinking = thinkingView(normalized, catalog);
  return {
    ...(fallback
      ? {
          notice: `The selected Provider or model is unavailable. Switched to ${effective.providerName ?? ""} ${effective.displayName}. You can choose another model.`,
        }
      : effective === undefined
        ? {
            notice:
              "No configured Provider is available. Choose another model or ask an administrator to enable a Provider.",
          }
        : {}),
    modelId,
    models,
    modeId: configuration.authorizationMode ?? catalog.defaultAuthorization.mode,
    modeValue: configuration.authorizationMode ?? "agent_default",
    defaultModeId: catalog.defaultAuthorization.mode,
    ...(thinking === undefined ? {} : { thinking }),
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
    if (
      next.thinkingEffort !== undefined &&
      !selectSessionModel(next, catalog)?.thinkingEfforts?.includes(next.thinkingEffort)
    )
      delete next.thinkingEffort;
  } else if (id === "thinking_effort") {
    if (value === "default") delete next.thinkingEffort;
    else {
      const effort = thinkingEffortSchema.safeParse(value);
      if (
        !effort.success ||
        !selectSessionModel(next, catalog)?.thinkingEfforts?.includes(effort.data)
      )
        throw new DomainError(
          "invalid_configuration",
          "Thinking effort is not supported by the selected model",
        );
      next.thinkingEffort = effort.data;
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

export function selectSessionModel(
  configuration: SessionConfiguration,
  catalog: ConfigurationCatalog,
): SessionModel | undefined {
  const manual = catalog.models.find(
    (model) => model.modelProfileId === configuration.modelProfileId,
  );
  if (manual !== undefined) return manual;
  if (
    configuration.modelProfileId !== undefined &&
    !catalog.unavailableModelProfileIds?.includes(configuration.modelProfileId)
  )
    return undefined;
  if (catalog.defaultModel.available) return catalog.defaultModel;
  return catalog.fallbackModels?.[0];
}

function thinkingView(
  configuration: SessionConfiguration,
  catalog: ConfigurationCatalog,
): SessionConfigurationView["thinking"] {
  const efforts = selectSessionModel(configuration, catalog)?.thinkingEfforts ?? [];
  if (efforts.length === 0 && configuration.thinkingEffort === undefined) return undefined;
  const options: ConfigurationChoice[] = [
    { id: "default", name: "Model default" },
    ...efforts.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) })),
  ];
  const currentValue = configuration.thinkingEffort ?? "default";
  if (!options.some((option) => option.id === currentValue))
    options.push({ id: currentValue, name: "Unavailable selected effort" });
  return { currentValue, options };
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
