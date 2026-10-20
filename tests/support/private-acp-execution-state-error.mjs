// Only the private reader emits this after a complete response matches the
// execution_state_unavailable contract. Keep the type independent of schema
// loading so consumers can recognize recovery without loading the reader.
export class PrivateACPExecutionStateUnavailableError extends Error {
  constructor() {
    super("ACP execution state is unavailable during recovery");
    this.name = "PrivateACPExecutionStateUnavailableError";
  }
}
