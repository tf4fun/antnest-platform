import { setTimeout as delay } from "node:timers/promises";
import { DomainError } from "../domain/errors.js";
import type { SkillProjection } from "../domain/skill-source.js";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";

export class SkillProjectionWorker {
  public constructor(
    private readonly dependencies: {
      repository: {
        pending(signal: AbortSignal): Promise<SkillProjection[]>;
        complete(projection: SkillProjection, delivered: boolean): Promise<void>;
        remove(projection: SkillProjection): Promise<void>;
      };
      directory: { inspect(identity: ExecutionIdentity): unknown };
      client: { send(projection: SkillProjection, signal: AbortSignal): Promise<unknown> };
      report: (outcome: "delivered" | "deferred" | "removed") => void;
    },
  ) {}

  public async tick(signal: AbortSignal): Promise<void> {
    for (const projection of await this.dependencies.repository.pending(signal)) {
      signal.throwIfAborted();
      try {
        if (projection.active) {
          try {
            this.dependencies.directory.inspect({
              organizationId: projection.organization_id,
              agentId: projection.agent_id,
              principalId: projection.owner_id,
            });
          } catch (error) {
            if (error instanceof DomainError && error.code === "access_denied") {
              await this.dependencies.repository.remove(projection);
              this.dependencies.report("removed");
              continue;
            }
            throw error;
          }
        }
        await this.dependencies.client.send(projection, signal);
        signal.throwIfAborted();
        await this.dependencies.repository.complete(projection, true);
        this.dependencies.report("delivered");
      } catch {
        signal.throwIfAborted();
        await this.dependencies.repository.complete(projection, false);
        this.dependencies.report("deferred");
      }
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        signal.throwIfAborted();
        await this.tick(signal);
      } catch {
        if (signal.aborted) return;
        this.dependencies.report("deferred");
      }
      try {
        await delay(1000, undefined, { signal });
      } catch {
        return;
      }
    }
  }
}
