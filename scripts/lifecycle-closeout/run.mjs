import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "./docker.mjs";
import { runFlow } from "./flow.mjs";
import { runNetwork } from "./network-flow.mjs";
import { runHealth } from "./health-flow.mjs";
import { configureRestore, runRestore } from "./restore-flow.mjs";
import { runLoss } from "./loss-flow.mjs";
import { inspectDeployment } from "./deployment.mjs";
import { runShutdown } from "./shutdown.mjs";

const profile = process.argv[2] ?? "foundation";
assert(
  ["foundation", "network", "health", "restore", "loss", "shutdown"].includes(
    profile,
  ) && process.argv.length <= 3,
);

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
if (profile === "foundation") {
  const { runFoundation } = await import("./foundation-run.mjs");
  await runFoundation();
} else {
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Lifecycle integration interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 900000);
  let config;
  let result;
  let deployment;
  try {
    config = await configuration(abort.signal);
    if (profile === "restore") configureRestore(config);
    console.error(`Disposable lifecycle project: ${config.project}`);
    const docker = dockerClient(config.env, abort.signal);
    await docker(composeArgs(config.project, ["config", "--quiet"]));
    await docker(
      composeArgs(config.project, [
        ...(["network", "restore", "loss"].includes(profile)
          ? ["-f", `scripts/lifecycle-closeout/${profile}.compose.yaml`]
          : []),
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
      ]),
      true,
    );
    if (profile === "foundation")
      deployment = await inspectDeployment(config, docker);
    result = await runFlow(
      config,
      docker,
      abort.signal,
      {
        network: runNetwork,
        health: runHealth,
        restore: runRestore,
        loss: runLoss,
        shutdown: runShutdown,
      }[profile],
    );
  } finally {
    clearTimeout(timer);
    if (config) await cleanup(config);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  abort.signal.throwIfAborted();
  console.log(
    JSON.stringify({
      status: "passed",
      ...result,
      deployment,
      cleanup: "verified",
    }),
  );
}
