import { DomainError } from "../domain/errors.js";
import {
  changeConfiguration,
  configurationView,
  type ConfigurationCatalog,
} from "../domain/session-configuration.js";
import type { ConnectionBinding } from "../domain/types.js";
import type { AgentControllerPort } from "../ports/agent-controller.js";
import type { SessionConfigurationRepository } from "../ports/session-configuration.js";
import type { SessionService } from "./session-service.js";

export class SessionConfigurationService {
  public constructor(
    private readonly dependencies: {
      sessions: Pick<SessionService, "requireAuthorized">;
      repository: SessionConfigurationRepository;
      controller: Pick<AgentControllerPort, "getSessionConfiguration">;
      id: () => string;
      now: () => Date;
    },
  ) {}

  public async get(input: { binding: ConnectionBinding; sessionId: string }) {
    await this.dependencies.sessions.requireAuthorized(input.sessionId, input.binding);
    const current = await this.dependencies.repository.get(input.sessionId);
    return configurationView(current.configuration, await this.catalog(input.binding));
  }

  public async set(input: {
    binding: ConnectionBinding;
    sessionId: string;
    configId: string;
    value: string | boolean;
  }) {
    await this.dependencies.sessions.requireAuthorized(input.sessionId, input.binding);
    const current = await this.dependencies.repository.get(input.sessionId);
    const catalog = await this.catalog(input.binding);
    const configuration = changeConfiguration(
      current.configuration,
      input.configId,
      input.value,
      catalog,
    );
    const view = configurationView(configuration, catalog);
    await this.dependencies.repository.save({
      sessionId: input.sessionId,
      expectedRevision: current.revision,
      configuration,
      view,
      changedAt: this.dependencies.now(),
    });
    return view;
  }

  private async catalog(binding: ConnectionBinding): Promise<ConfigurationCatalog> {
    const input = {
      requestId: this.dependencies.id(),
      agentId: binding.agentId,
      principalId: binding.principalId,
      expectedAccessRevision: binding.accessRevision,
      limit: 200,
    };
    const first = await this.dependencies.controller.getSessionConfiguration(input);
    const models = new Map(first.models.map((model) => [model.modelProfileId, model]));
    const seen = new Set<string>();
    let cursor = first.nextCursor;
    while (cursor !== "") {
      if (seen.has(cursor))
        throw new DomainError("invalid_model_catalog", "Model catalog cursor did not advance");
      seen.add(cursor);
      const page = await this.dependencies.controller.getSessionConfiguration({
        ...input,
        requestId: this.dependencies.id(),
        afterId: cursor,
      });
      for (const model of page.models) models.set(model.modelProfileId, model);
      cursor = page.nextCursor;
    }
    return { ...first, models: [...models.values()] };
  }
}
