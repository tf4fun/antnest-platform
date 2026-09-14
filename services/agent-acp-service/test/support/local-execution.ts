import { vi } from "vitest";
import { ExecutionDirectory } from "../../src/application/execution-directory.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import type { PublicExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import type { ExecutionConfigurationRepository } from "../../src/ports/execution-configuration.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

export async function localExecution(initialize = true) {
  const configurations = new Map<string, PublicExecutionConfiguration>();
  const repository: ExecutionConfigurationRepository = {
    load: (id) => Promise.resolve(structuredClone(configurations.get(id) ?? null)),
    save: (value, revision) => {
      if ((configurations.get(value.organization_id)?.revision ?? null) !== revision)
        return Promise.resolve(false);
      configurations.set(value.organization_id, structuredClone(value));
      return Promise.resolve(true);
    },
  };
  const clients = new ProviderClients({
    complete: () => Promise.reject(new Error("Unexpected model request")),
  });
  const onApplied = vi.fn(() => Promise.resolve());
  const onUnavailable = vi.fn();
  const directory = new ExecutionDirectory({ repository, clients, onApplied, onUnavailable });
  if (initialize) await directory.apply(executionConfiguration());
  return { directory, clients, repository, configurations, onApplied, onUnavailable };
}
