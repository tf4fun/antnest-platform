import assert from "node:assert/strict";
import { composeArgs } from "../lifecycle-closeout/docker.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

// Keep the owning Skill workflow's full business startup and health gates.
// Observability is started separately so its health cannot gate those checks.
export function skillComposeArgs(project, args) {
  const command = composeArgs(project, args);
  const profiles = command.flatMap((value, index) =>
    value === "--profile" && command[index + 1] === "observability"
      ? [index]
      : [],
  );
  assert.equal(profiles.length, 1, "expected one observability profile");
  const index = profiles[0];
  return [...command.slice(0, index), ...command.slice(index + 2)];
}

export async function startSkillObservability({
  docker,
  project,
  overlay = [],
  directory,
  signal,
  budgetMs = 60_000,
}) {
  const trace = createTraceDiagnostics({ directory, signal, budgetMs });
  await trace.run("skill-observability-startup", (localSignal) =>
    docker(
      composeArgs(project, [
        ...overlay,
        "up",
        "-d",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "45",
        "jaeger",
        "runtime-telemetry-ingress",
      ]),
      true,
      { signal: localSignal },
    ),
  );
  const summary = trace.summary();
  if (summary.status === "warning") {
    console.warn(
      "Skill observability startup reported a diagnostic warning; continuing independent business checks.",
    );
  }
  return summary;
}
