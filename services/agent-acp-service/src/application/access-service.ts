import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import type { ExecutionDirectory } from "./execution-directory.js";

export type AccessServiceDependencies = {
  directory: ExecutionDirectory;
};

export class AccessService {
  public constructor(private readonly dependencies: AccessServiceDependencies) {}

  public async assert(binding: ExecutionIdentity): Promise<void> {
    await this.dependencies.directory.withAccess(binding, () => Promise.resolve());
  }

  public withAccess<T>(
    identity: ExecutionIdentity,
    commit: (accessRevision: string) => Promise<T>,
  ): Promise<T> {
    return this.dependencies.directory.withAccess(identity, ({ agent }) =>
      commit(agent.access_revision),
    );
  }
}
