import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { configuration, dockerClient, cleanup, lines } from "./docker.mjs";
import {
  configureFoundation,
  inspectFoundationDeployment,
} from "./foundation-setup.mjs";
import { applicationServices, assertDeployment } from "./deployment.mjs";
import { runFoundationFlow } from "./foundation-flow.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";

export async function runFoundation() {
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Foundation verification interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 900000);
  let config, result, deployment, failure;
  try {
    config = await configuration(abort.signal);
    configureFoundation(config);
    config.evidence = `.cache/lifecycle-foundation/${config.project}`;
    await mkdir(`${config.evidence}/traces`, { recursive: true, mode: 0o700 });
    console.error(`Disposable foundation project: ${config.project}`);
    const docker = dockerClient(config.env, abort.signal);
    await docker(config.compose(["config", "--quiet"]));
    await docker(
      config.compose([
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
        "--pull",
        "never",
      ]),
      true,
    );
    const ids = lines(
      await docker([
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${config.project}`,
      ]),
    );
    const rows = JSON.parse(await docker(["inspect", ...ids]));
    await writeFile(
      `${config.evidence}/deployment.private.json`,
      JSON.stringify(rows),
      { mode: 0o600 },
    );
    deployment = inspectFoundationDeployment(rows, config);
    const images = {};
    for (const name of applicationServices)
      images[name] = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        name === "agent-controller"
          ? config.controllerImage
          : `antnest/${name}:local`,
      ]);
    assertDeployment(
      config,
      rows
        .filter(
          (r) => r.Config.Labels["com.docker.compose.service"] !== "temporal",
        )
        .map((r) => ({
          id: r.Id,
          labels: r.Config.Labels,
          image: r.Image,
          running: r.State.Running,
          health: r.State.Health?.Status ?? "none",
          ports: r.NetworkSettings.Ports,
        })),
      images,
    );
    result = await runFoundationFlow(config, docker, abort.signal);
    await writeFile(
      `${config.evidence}/business.json`,
      JSON.stringify(result),
      { mode: 0o600 },
    );
  } catch (error) {
    failure = error;
    if (config?.evidence)
      await writeFile(
        `${config.evidence}/failure.private.txt`,
        String(error.stack),
        { mode: 0o600 },
      );
  } finally {
    clearTimeout(timer);
    try {
      if (config) await cleanup(config);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
  if (failure) {
    console.error(
      "Foundation business/topology failed; diagnostics retained privately",
    );
    process.exitCode = 1;
    return;
  }
  abort.signal.throwIfAborted();
  assert(result);
  const code = foundationTraceExitCode([
    ...result.traces,
    ...result.active_run_rebuild.run_traces,
  ]);
  console.log(
    JSON.stringify({
      status:
        code === 1
          ? "business_passed_trace_failed"
          : "business_and_topology_passed",
      ...result,
      deployment,
      cleanup: "verified",
      strict_exit: code,
    }),
  );
  process.exitCode = code;
}
