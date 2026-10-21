import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

export async function collectSessionDiagnostics({
  directory,
  signal,
  budgetMs,
  owner,
  requests,
  request,
  strict,
}) {
  const diagnostics = createTraceDiagnostics({ directory, signal, budgetMs });
  const ownerResult = await diagnostics.run("session-owner", (localSignal) =>
    owner(localSignal),
  );
  const collectedOwner =
    ownerResult.status === "passed" ? ownerResult.value : undefined;
  const traces = collectedOwner?.traces ?? [];
  const executionTraces = [];
  for (const [index, expected] of requests.entries()) {
    const result = await diagnostics.run(
      `session-request-${index + 1}`,
      (localSignal) => request(expected, localSignal),
    );
    if (result.status === "passed") executionTraces.push(result.value);
  }
  await diagnostics.run("session-strict", () =>
    strict([...traces, ...executionTraces]),
  );
  return {
    traces,
    executionTraces,
    ownerClose: collectedOwner?.ownerClose,
    ownerDiagnostics: collectedOwner?.diagnostics,
    diagnostics: diagnostics.summary(),
  };
}
