export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue | undefined>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface TelemetryPort {
  span<Result>(
    name: string,
    attributes: TelemetryAttributes,
    operation: () => Promise<Result>,
  ): Promise<Result>;
  count(name: string, attributes: TelemetryAttributes, value?: number): void;
  duration(name: string, milliseconds: number, attributes: TelemetryAttributes): void;
  log(level: LogLevel, event: string, attributes?: TelemetryAttributes, error?: unknown): void;
}

export const NOOP_TELEMETRY: TelemetryPort = {
  span: async <Result>(
    _name: string,
    _attributes: TelemetryAttributes,
    operation: () => Promise<Result>,
  ) => operation(),
  count: () => undefined,
  duration: () => undefined,
  log: () => undefined,
};
