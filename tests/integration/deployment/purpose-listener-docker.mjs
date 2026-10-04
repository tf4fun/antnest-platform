import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dockerClient,
  lines,
  networkOctet,
} from "../../e2e/lifecycle-closeout/docker.mjs";

const project = `antnest-purpose-probe-${randomUUID().slice(0, 8)}`;
const label = `io.antnest.deployment-probe=${project}`;
const output = fileURLToPath(
  new URL(`../../../artifacts/verification/${project}/`, import.meta.url),
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const controller = new AbortController();
const interrupt = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
const docker = dockerClient(process.env, controller.signal, 120000);
const cleanup = dockerClient(process.env, undefined, 60000);
const baseline = {};
for (const [kind, args] of [
  ["container", ["ps", "-aq"]],
  ["network", ["network", "ls", "-q"]],
  ["volume", ["volume", "ls", "-q"]],
])
  baseline[kind] = lines(await docker(args)).sort();
const octet = await networkOctet(docker, 1 + (process.pid % 200));
const purpose = `${project}-purpose`,
  outbound = `${project}-outbound`;
const purposeAddress = `10.242.${octet}.2`,
  outboundAddress = `10.243.${octet}.2`;
const fixture = fileURLToPath(
  new URL("./fixtures/purpose-listener.mjs", import.meta.url),
);
const report = { project, observations: [], cleanup: false };
let primaryError, cleanupError;

try {
  await docker([
    "network",
    "create",
    "--internal",
    "--subnet",
    `10.242.${octet}.0/28`,
    "--label",
    label,
    purpose,
  ]);
  await docker([
    "network",
    "create",
    "--subnet",
    `10.243.${octet}.0/28`,
    "--label",
    label,
    outbound,
  ]);
  for (const [name, connectOutbound, listenOutbound] of [
    ["internal-only", false, false],
    ["unicast-with-outbound", true, false],
    ["identify-published-interface", true, true],
  ]) {
    controller.signal.throwIfAborted();
    const id = await docker([
      "create",
      "--name",
      `${project}-${name}`,
      "--label",
      label,
      "--network",
      purpose,
      "--ip",
      purposeAddress,
      "--publish",
      "127.0.0.1::8080",
      "--user",
      "65532:65532",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--env",
      `PURPOSE_ADDRESS=${purposeAddress}`,
      ...(listenOutbound
        ? ["--env", `OUTBOUND_ADDRESS=${outboundAddress}`]
        : []),
      "--mount",
      `type=bind,src=${fixture},dst=/probe.mjs,readonly`,
      "--health-cmd",
      `node -e "fetch('http://${purposeAddress}:8080/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"`,
      "--health-interval",
      "1s",
      "--health-timeout",
      "3s",
      "--health-retries",
      "10",
      "node:24.21.0-bookworm-slim",
      "node",
      "/probe.mjs",
    ]);
    if (connectOutbound)
      await docker([
        "network",
        "connect",
        "--gw-priority",
        "1",
        "--ip",
        outboundAddress,
        outbound,
        id,
      ]);
    await docker(["start", id]);
    let row;
    const deadline = Date.now() + 15000;
    do {
      row = JSON.parse(await docker(["inspect", id]))[0];
      if (row.State.Health?.Status === "healthy") break;
      assert(
        Date.now() < deadline,
        "own primary listener did not become healthy",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (row.State.Health?.Status !== "healthy");
    assert.equal(row.Config.Labels["io.antnest.deployment-probe"], project);
    const binding = row.NetworkSettings.Ports["8080/tcp"]?.[0];
    let hostListener = "unpublished";
    if (binding) {
      assert.equal(binding.HostIp, "127.0.0.1");
      try {
        const response = await fetch(`http://127.0.0.1:${binding.HostPort}/`, {
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(response.status, 200);
        hostListener = (await response.json()).listener;
        assert(["purpose", "outbound"].includes(hostListener));
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof TypeError) && error.name !== "TimeoutError")
          throw error;
        hostListener = "unreachable";
      }
    }
    report.observations.push({
      name,
      primary_healthy: true,
      host_listener: hostListener,
    });
    await docker(["stop", "--time", "5", id]);
    const stopped = JSON.parse(await docker(["inspect", id]))[0];
    assert.equal(stopped.State.ExitCode, 0, "probe did not shut down normally");
    await docker(["rm", id]);
  }
  assert.deepEqual(report.observations, [
    {
      name: "internal-only",
      primary_healthy: true,
      host_listener: "unpublished",
    },
    {
      name: "unicast-with-outbound",
      primary_healthy: true,
      host_listener: "unreachable",
    },
    {
      name: "identify-published-interface",
      primary_healthy: true,
      host_listener: "outbound",
    },
  ]);
} catch (error) {
  primaryError = error;
} finally {
  try {
    // Discover by the private label as well: a cancelled create may have been
    // accepted by Docker before its CLI returned a tracked container ID.
    for (const id of lines(
      await cleanup(["ps", "-aq", "--filter", `label=${label}`]),
    )) {
      const row = JSON.parse(await cleanup(["inspect", id]))[0];
      assert.equal(row.Config.Labels["io.antnest.deployment-probe"], project);
      if (row.State.Running) await cleanup(["stop", "--time", "5", id]);
      await cleanup(["rm", id]);
    }
    const networks = lines(
      await cleanup(["network", "ls", "-q", "--filter", `label=${label}`]),
    );
    for (const id of networks) await cleanup(["network", "rm", id]);
    for (const [kind, args] of [
      ["container", ["ps", "-aq"]],
      ["network", ["network", "ls", "-q"]],
      ["volume", ["volume", "ls", "-q"]],
    ])
      assert.deepEqual(
        lines(await cleanup(args)).sort(),
        baseline[kind],
        `${kind} baseline changed`,
      );
    report.cleanup = true;
  } catch (error) {
    cleanupError = error;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
  writeFileSync(
    `${output}/observations.json`,
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
if (primaryError || cleanupError)
  throw new AggregateError(
    [primaryError, cleanupError].filter(Boolean),
    "purpose listener probe failed",
  );
console.log(JSON.stringify(report));
