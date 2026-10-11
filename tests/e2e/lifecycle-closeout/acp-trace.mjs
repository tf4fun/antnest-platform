import { collectWorkspaceRequestTrace } from "../workspace-closeout/request-trace.mjs";

// Lifecycle uses the same direct ACP request boundary as Workspace. Keep the
// owning Run/rejection inspector inside the collector so raw source diagnostics
// cannot be replaced by a second current-Trace-only strict check afterward.
export function collectLifecycleACPTrace(
  config,
  expected,
  secrets,
  requests,
  inspect,
  signal,
  options = {},
) {
  return collectWorkspaceRequestTrace(
    config.jaeger,
    expected,
    secrets,
    requests,
    {
      ...options,
      directory: `${config.evidence}/traces`,
      signal,
      onSelected: (traceID) => {
        expected.traceID = traceID;
      },
      inspect,
    },
  );
}
