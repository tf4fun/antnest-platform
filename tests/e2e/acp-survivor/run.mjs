import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  configuration,
  dockerClient,
  cleanup,
  lines,
} from "../lifecycle-closeout/docker.mjs";
import {
  configureFoundation,
  inspectFoundationDeployment,
} from "../lifecycle-closeout/foundation-setup.mjs";
import {
  applicationServices,
  assertDeployment,
} from "../lifecycle-closeout/deployment.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { prepareSurvivorProfile } from "./profile.mjs";
import { runSurvivorBusiness, requiredChecks } from "./business.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
process.chdir(root);
const previousMask = process.umask(0o077);
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("ACP survivor acceptance interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 900000);
const errors = [];
const report = {
  status: "running",
  checks: [],
  business_completed: false,
  cleanup: "pending",
};
let config, directory, aId, ownedCredentials;
const checkpoint = async () => {
  if (directory)
    writeEvidenceFile(
      directory,
      "business.json",
      JSON.stringify(report, null, 2),
    );
};
try {
  config = await configuration(abort.signal, (project) => {
    const parent = resolve(
      root,
      "artifacts/verification/authenticated-e2e",
      project,
    );
    assert.equal(
      existsSync(parent),
      false,
      "Disposable project already exists",
    );
    // configuration can fail after provisioning credentials but before it
    // returns. Own this exact new project before any such side effect.
    config = { project, env: process.env };
    ownedCredentials = resolve(parent, "credentials");
    directory = evidenceDirectory(
      `artifacts/verification/acp-survivor/${project}`,
    );
  });
  config.evidence = directory;
  configureFoundation(config);
  prepareSurvivorProfile(config);
  const base = config.compose;
  config.compose = (args) =>
    base(["-f", "tests/e2e/acp-survivor/compose.yaml", ...args]);
  const docker = dockerClient(config.env, abort.signal);
  const rendered = await docker(config.compose(["config", "--format", "json"]));
  writeEvidenceFile(directory, "compose.private.json", rendered);
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
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${config.project}`,
    ]),
  );
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  writeEvidenceFile(directory, "deployment.private.json", JSON.stringify(rows));
  const service = (row) => row.Config.Labels["com.docker.compose.service"];
  const peers = rows.filter((row) => service(row) === "agent-acp-peer-b");
  assert.equal(peers.length, 1);
  const peer = peers[0];
  const baseRows = rows.filter((row) => row !== peer);
  const deployment = inspectFoundationDeployment(baseRows, config);
  const images = {};
  for (const name of applicationServices)
    images[name] = (
      await docker([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        config.images[name],
      ])
    ).trim();
  assertDeployment(
    config,
    baseRows.map((row) => ({
      id: row.Id,
      labels: row.Config.Labels,
      image: row.Image,
      running: row.State.Running,
      health: row.State.Health?.Status ?? "none",
      ports: row.NetworkSettings.Ports,
    })),
    images,
  );
  const a = baseRows.find((row) => service(row) === "agent-acp-service");
  aId = a.Id;
  assert.equal(
    peer.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(peer.Image, a.Image);
  assert.equal(peer.State.Running, true);
  assert.equal(peer.State.Health.Status, "healthy");
  assert.deepEqual(
    Object.values(peer.HostConfig.PortBindings ?? {}).flat(),
    [],
  );
  assert.equal(peer.Config.User, a.Config.User);
  for (const [name, row] of [
    ["acp-a", a],
    ["acp-b", peer],
  ]) {
    assert(row.Config.Env.includes(`ANTNEST_ACP_OWNER_MEMBER_ID=${name}`));
    const mount = row.Mounts.find(
      (item) => item.Destination === "/etc/antnest/acp-peer",
    );
    assert(mount && mount.RW === false);
  }
  report.deployment = {
    ...deployment,
    services: rows.length,
    acp_replicas: 2,
    same_candidate_image: true,
  };
  report.project = config.project;
  await checkpoint();
  await runSurvivorBusiness(config, docker, abort.signal, report, checkpoint);
  assert.deepEqual(report.checks, requiredChecks);
  assert.equal(report.business_completed, true);
} catch (error) {
  errors.push(error);
  if (config && directory) {
    // Diagnostics use a separate bounded lifetime; collection is auxiliary.
    try {
      const diagnostic = dockerClient(config.env, undefined, 30000);
      const ids = lines(
        await diagnostic([
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${config.project}`,
        ]),
      );
      const logs = {};
      for (const id of ids)
        logs[id] = await diagnostic(["logs", "--tail", "250", id], false, {
          captureStderr: true,
        });
      writeEvidenceFile(
        directory,
        "services.private.json",
        JSON.stringify(logs),
      );
    } catch {
      report.diagnostic_warning = "service log collection unavailable";
    }
  }
} finally {
  clearTimeout(timer);
  if (config) {
    if (aId) {
      try {
        const finalDocker = dockerClient(config.env, undefined, 60000);
        await finalDocker(["stop", "-t", "20", aId], true);
        const [stopped] = JSON.parse(await finalDocker(["inspect", aId]));
        assert.equal(stopped.State.Running, false);
        assert.equal(stopped.State.OOMKilled, false);
        assert.equal(
          stopped.State.ExitCode,
          0,
          "Survivor must join its original resources on normal shutdown",
        );
        report.survivor_shutdown = { exit_code: 0, container: aId };
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (ownedCredentials && existsSync(ownedCredentials))
        config.credentials = ownedCredentials;
      await cleanup(config);
      report.cleanup = "verified";
    } catch (error) {
      report.cleanup = "failed";
      errors.push(error);
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (abort.signal.aborted) errors.push(abort.signal.reason);
  report.status =
    errors.length === 0 &&
    report.business_completed &&
    report.cleanup === "verified"
      ? "passed"
      : "failed";
  report.trace_collection = { status: "not_collected", auxiliary: true };
  try {
    await checkpoint();
    if (directory && errors.length)
      writeEvidenceFile(
        directory,
        "failure.private.txt",
        inspect(new AggregateError(errors, "ACP survivor acceptance failed"), {
          depth: 12,
        }),
      );
  } catch (error) {
    errors.push(error);
    report.status = "failed";
  }
  process.umask(previousMask);
}
process.exitCode = report.status === "passed" ? 0 : 1;
console.log(
  JSON.stringify({
    status: report.status,
    business_completed: report.business_completed,
    checks: report.checks,
    cleanup: report.cleanup,
    survivor_shutdown: report.survivor_shutdown?.exit_code,
    trace_collection: report.trace_collection,
    evidence: directory,
  }),
);
