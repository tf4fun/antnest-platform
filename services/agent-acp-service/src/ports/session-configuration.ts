import type {
  SessionConfiguration,
  SessionConfigurationView,
} from "../domain/session-configuration.js";

export interface SessionConfigurationRepository {
  get(sessionId: string): Promise<{ configuration: SessionConfiguration; revision: number }>;
  save(input: {
    sessionId: string;
    expectedRevision: number;
    configuration: SessionConfiguration;
    view: SessionConfigurationView;
    changedAt: Date;
  }): Promise<void>;
}
