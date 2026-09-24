import { executionConfigurationCatalog } from "../domain/execution-configuration.js";
import { configurationRevisionToken } from "../domain/configuration-revision.js";
import { DomainError } from "../domain/errors.js";
import { changeConfiguration, configurationView } from "../domain/session-configuration.js";
import type { ConnectionBinding } from "../domain/types.js";
import type { SessionConfigurationRepository } from "../ports/session-configuration.js";
import type { ExecutionDirectory } from "./execution-directory.js";
import type { SessionService } from "./session-service.js";

export class SessionConfigurationService {
  public constructor(
    private readonly dependencies: {
      sessions: Pick<SessionService, "requireAuthorized">;
      repository: SessionConfigurationRepository;
      directory: ExecutionDirectory;
      now: () => Date;
    },
  ) {}

  public get(input: { binding: ConnectionBinding; sessionId: string }) {
    return this.dependencies.directory.withAccess(
      input.binding,
      async ({ configuration, agent }) => {
        await this.dependencies.sessions.requireAuthorized(input.sessionId, input.binding);
        const current = await this.dependencies.repository.get(input.sessionId);
        return configurationView(
          current.configuration,
          executionConfigurationCatalog(configuration, agent),
        );
      },
    );
  }

  public set(input: {
    binding: ConnectionBinding;
    sessionId: string;
    configId: string;
    value: string | boolean;
    expectedRevision?: string;
  }) {
    return this.dependencies.directory.withAccess(
      input.binding,
      async ({ configuration: snapshot, agent }) => {
        await this.dependencies.sessions.requireAuthorized(input.sessionId, input.binding);
        const current = await this.dependencies.repository.get(input.sessionId);
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== configurationRevisionToken(input.sessionId, current.revision)
        )
          throw new DomainError(
            "configuration_conflict",
            "Session configuration changed; reload and retry",
          );
        const catalog = executionConfigurationCatalog(snapshot, agent);
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
      },
    );
  }
}
