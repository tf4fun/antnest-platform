import type * as v1 from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  authorizationModes,
  type SessionConfigurationView,
  type ConfigurationChoice,
} from "../../domain/session-configuration.js";

function choices(values: ConfigurationChoice[]) {
  return values.map(({ id, ...fields }) => ({ value: id, ...fields }));
}

export function v1Configuration(view: SessionConfigurationView) {
  const configOptions: v1.SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: view.modelId,
      options: choices(view.models),
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
  return {
    configOptions,
    modes: { currentModeId: view.modeId, availableModes: authorizationModes },
  };
}

export function v2Configuration(view: SessionConfigurationView): {
  configOptions: v2.SessionConfigOption[];
} {
  const configOptions: v2.SessionConfigOption[] = v1Configuration(view).configOptions.map(
    ({ id, ...option }) => ({ ...option, configId: id }),
  );
  return { configOptions };
}
