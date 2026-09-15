import type * as v1 from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  authorizationModes,
  type SessionConfigurationView,
  type ConfigurationChoice,
} from "../../domain/session-configuration.js";

function choices(values: ConfigurationChoice[]) {
  return values.map(({ id, name, description }) => ({
    value: id,
    name,
    ...(description === undefined ? {} : { description }),
  }));
}

function modelChoices(values: ConfigurationChoice[]): v1.SessionConfigSelectOptions {
  if (!values.some((value) => value.providerName !== undefined)) return choices(values);
  const groups = new Map<string, ConfigurationChoice[]>();
  for (const value of values) {
    const key = value.providerName ?? "agent";
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return [...groups].map(([group, values]) => ({
    group,
    name: group === "agent" ? "Agent" : group,
    options: choices(values),
  }));
}

export function v1Configuration(view: SessionConfigurationView) {
  const configOptions: v1.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: view.modelId,
      ...(view.notice === undefined ? {} : { description: view.notice }),
      options: modelChoices(view.models),
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: view.modeValue,
      options: choices([
        { id: "agent_default", name: `Agent default: ${view.defaultModeId}` },
        ...authorizationModes,
      ]),
    },
  ];
  if (view.thinking !== undefined)
    configOptions.push({
      id: "thinking_effort",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      description: "Reasoning effort for the selected model.",
      currentValue: view.thinking.currentValue,
      options: choices(view.thinking.options),
    });
  return {
    configOptions,
    modes: { currentModeId: view.modeId, availableModes: authorizationModes },
  };
}

export function v2Configuration(view: SessionConfigurationView): {
  configOptions: v2.SessionConfigOption[];
} {
  const configOptions: v2.SessionConfigOption[] = v1Configuration(view).configOptions.map(
    ({ id, ...option }) => {
      if (option.type !== "select") return { ...option, configId: id };
      const options = option.options.map((choice) => {
        if (!("group" in choice)) return choice;
        const { group, ...fields } = choice;
        return { ...fields, groupId: group };
      });
      return { ...option, configId: id, options };
    },
  );
  return { configOptions };
}
