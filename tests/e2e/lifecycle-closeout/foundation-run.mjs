import {
  evidenceDirectory,
  evidenceFilePath,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdir } from "node:fs/promises";
import { configuration, dockerClient, cleanup, lines } from "./docker.mjs";
import {
  configureFoundation,
  inspectFoundationDeployment,
} from "./foundation-setup.mjs";
import { applicationServices, assertDeployment } from "./deployment.mjs";
import { runFoundationFlow } from "./foundation-flow.mjs";
import { foundationTraceExitCode } from "./foundation-evidence.mjs";

export async function runFoundation(profile = "foundation") {
  assert(
    [
      "foundation",
      "network",
      "shutdown",
      "health",
      "restore",
      "loss",
      "interrupted",
      "crash",
      "workspace",
      "workspace-browser",
    ].includes(profile),
  );
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("Foundation verification interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(interrupt, 900000);
  let config, result, deployment, failure;
  try {
    config = await configuration(abort.signal, (project) => {
      const directory = evidenceDirectory(
        `artifacts/verification/lifecycle-${profile}/${project}`,
      );
      evidenceDirectory(`${directory}/traces`);
      for (const name of [
        "deployment.private.json",
        "business.json",
        "failure.private.txt",
        "services.private.json",
      ])
        evidenceFilePath(directory, name);
    });
    configureFoundation(config);
    if (
      [
        "network",
        "restore",
        "loss",
        "interrupted",
        "crash",
        "workspace",
        "workspace-browser",
      ].includes(profile)
    ) {
      const foundationCompose = config.compose;
      config.compose = (args) =>
        foundationCompose([
          "-f",
          profile === "workspace"
            ? "tests/e2e/workspace-closeout/compose.yaml"
            : profile === "workspace-browser"
              ? "tests/e2e/workspace-closeout/browser.compose.yaml"
              : `tests/e2e/lifecycle-closeout/${profile === "interrupted" ? "update-receipt" : profile}.compose.yaml`,
          ...args,
        ]);
    }
    if (profile === "restore")
      (await import("./restore-flow.mjs")).configureRestore(config);
    config.evidence = `artifacts/verification/lifecycle-${profile}/${config.project}`;
    evidenceDirectory(config.evidence);
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
    writeEvidenceFile(
      config.evidence,
      "deployment.private.json",
      JSON.stringify(rows),
    );
    let baseRows = rows;
    if (profile === "network") {
      const { inspectNetworkTarget } = await import("./network-current.mjs");
      inspectNetworkTarget(rows, config);
      baseRows = rows.filter(
        (r) =>
          r.Config.Labels["com.docker.compose.service"] !== "network-target",
      );
    }
    if (profile === "interrupted") {
      const { inspectUpdateProxyDeployment } =
        await import("./interrupted-current.mjs");
      inspectUpdateProxyDeployment(rows, config);
      baseRows = rows.filter(
        (r) => r.Config.Labels["com.docker.compose.service"] !== "update-proxy",
      );
    }
    if (profile === "crash") {
      const peers = rows.filter(
        (r) => r.Config.Labels["com.docker.compose.service"] === "crash-proxy",
      );
      assert.equal(peers.length, 1);
      const peer = peers[0];
      assert.equal(
        peer.Config.Labels["com.docker.compose.project"],
        config.project,
      );
      assert.equal(peer.State.Health.Status, "healthy");
      assert.deepEqual(peer.HostConfig.PortBindings ?? {}, {});
      assert.deepEqual(Object.keys(peer.NetworkSettings.Networks), [
        `${config.project}_development`,
      ]);
      const rc = rows.find(
        (r) =>
          r.Config.Labels["com.docker.compose.service"] ===
          "runtime-controller",
      );
      assert(
        rc.Config.Env.includes("ANTNEST_DOCKER_HOST=unix:///fault/docker.sock"),
      );
      assert.equal(
        rc.Mounts.find((m) => m.Destination === "/fault")?.Name,
        peer.Mounts.find((m) => m.Destination === "/fault")?.Name,
      );
      baseRows = rows.filter((r) => r !== peer);
    }
    deployment = {
      ...inspectFoundationDeployment(baseRows, config),
      services: rows.length,
    };
    const images = {};
    for (const name of applicationServices)
      images[name] = await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        name === "agent-controller"
          ? config.controllerImage
          : name === "runtime-controller"
            ? config.runtimeControllerImage
            : `antnest/${name}:local`,
      ]);
    assertDeployment(
      config,
      baseRows
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
    const scenario =
      profile === "crash"
        ? (await import("./crash-flow.mjs")).runCrash
        : profile === "network"
          ? (await import("./network-flow.mjs")).runNetwork
          : profile === "shutdown"
            ? (await import("./shutdown.mjs")).runShutdown
            : profile === "health"
              ? (await import("./health-flow.mjs")).runHealth
              : profile === "restore"
                ? (await import("./restore-flow.mjs")).runRestore
                : profile === "loss"
                  ? (await import("./loss-flow.mjs")).runLoss
                  : profile === "interrupted"
                    ? (await import("./update-receipt-flow.mjs"))
                        .runUpdateReceipt
                    : profile === "workspace"
                      ? (await import("../workspace-closeout/current-flow.mjs"))
                          .workspaceProtocol
                      : profile === "workspace-browser"
                        ? (
                            await import("../workspace-closeout/browser-current-flow.mjs")
                          ).runBrowserProfile
                        : undefined;
    result = await runFoundationFlow(config, docker, abort.signal, scenario);
    writeEvidenceFile(config.evidence, "business.json", JSON.stringify(result));
  } catch (error) {
    failure = error;
    if (config?.evidence)
      writeEvidenceFile(
        config.evidence,
        "failure.private.txt",
        inspect(error, { depth: 8 }),
      );
    if (
      config?.evidence &&
      [
        "shutdown",
        "health",
        "restore",
        "loss",
        "interrupted",
        "crash",
        "workspace",
        "workspace-browser",
      ].includes(profile)
    ) {
      // Preserve bounded, private service diagnostics before owned cleanup.
      const diagnostics = {};
      try {
        const diagnosticDocker = dockerClient(config.env, undefined, 60000);
        const ids = lines(
          await diagnosticDocker([
            "ps",
            "-aq",
            "--filter",
            `label=com.docker.compose.project=${config.project}`,
          ]),
        );
        for (const id of ids) {
          try {
            diagnostics[id] = await diagnosticDocker([
              "logs",
              "--tail",
              "100",
              id,
            ]);
          } catch {
            diagnostics[id] = "diagnostic retrieval failed";
          }
        }
      } catch {
        diagnostics.retrieval = "diagnostic retrieval failed";
      }
      writeEvidenceFile(
        config.evidence,
        "services.private.json",
        JSON.stringify(diagnostics),
      );
    }
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
    ...(result.active_run_rebuild?.run_traces ?? result.request_traces ?? []),
    ...(result.policy_traces ?? []),
    ...(result.watch_traces ?? []),
  ]);
  console.log(
    JSON.stringify({
      status:
        code === 1
          ? "business_passed_trace_failed"
          : profile === "crash"
            ? "business_and_recovery_topology_passed"
            : "business_and_topology_passed",
      ...result,
      deployment,
      cleanup: "verified",
      strict_exit: code,
    }),
  );
  process.exitCode = code;
}
