type WorkspaceShutdownOptions = {
  service: { close(): Promise<void> };
  telemetry: { shutdown(): Promise<void> };
  authentication: { close(): Promise<void> };
  reportError?(message: string, error?: unknown): void;
  reportWarning?(message: string, error: unknown): void;
};

export async function shutdownWorkspaceService(
  options: WorkspaceShutdownOptions,
): Promise<0 | 1> {
  const {
    service,
    telemetry,
    authentication,
    reportError = console.error,
    reportWarning = console.warn,
  } = options;
  let failed = false;
  try {
    await service.close();
  } catch (error) {
    reportError("Bridge shutdown failed", error);
    failed = true;
  }
  try {
    await telemetry.shutdown();
  } catch (error) {
    reportWarning("Bridge telemetry shutdown warning", error);
  }
  try {
    await authentication.close();
  } catch {
    reportError("Bridge authentication client shutdown failed");
    failed = true;
  }
  return failed ? 1 : 0;
}
