import { DomainError } from "../domain/errors.js";
import type { ConnectionBinding } from "../domain/types.js";
import type { AccessService } from "./access-service.js";
import type {
  BridgeIntentReceipt,
  BridgeObservationRepository,
  BridgeSessionExecution,
} from "../ports/bridge-observation.js";

export type BridgeObservationServiceDependencies = {
  access: Pick<AccessService, "assert">;
  sessions: { requireAuthorized(sessionId: string, binding: ConnectionBinding): Promise<unknown> };
  repository: BridgeObservationRepository;
};

export class BridgeObservationService {
  public constructor(private readonly dependencies: BridgeObservationServiceDependencies) {}

  public async readIntent(
    binding: ConnectionBinding,
    sessionId: string,
    intentId: string,
  ): Promise<BridgeIntentReceipt | null> {
    await this.dependencies.access.assert(binding);
    await this.dependencies.sessions.requireAuthorized(sessionId, binding);
    return this.dependencies.repository.readIntent(sessionId, intentId);
  }

  public async readSession(
    binding: ConnectionBinding,
    sessionId: string,
  ): Promise<BridgeSessionExecution> {
    await this.dependencies.access.assert(binding);
    await this.dependencies.sessions.requireAuthorized(sessionId, binding);
    const state = await this.dependencies.repository.readSession(sessionId);
    if (state === null) throw new DomainError("session_not_found", "Session does not exist");
    return state;
  }
}
