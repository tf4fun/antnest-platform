import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  dockerClient,
  lines,
  scopeLabel,
} from "../lifecycle-closeout/docker.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = process.env.TEST_DOCKER_PROJECT;
const docker = dockerClient(process.env, undefined, 600000);

async function attachment(agentID) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const token = resolve(
    process.env.ANTNEST_SERVICE_AUTH_DIRECTORY,
    "agent-controller/tokens/runtime-egress",
  );
  return JSON.parse(
    await docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--label",
      `com.docker.compose.project=${project}`,
      "--network",
      `${project}_control`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${token},dst=/proof/token,readonly`,
      "--mount",
      `type=bind,src=${resolve(root, "tests/e2e/runtime-egress/read-attachment.mjs")},dst=/proof/read.mjs,readonly`,
      "node:24.21.0-bookworm-slim",
      "node",
      "/proof/read.mjs",
      `http://${process.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081`,
      agentID,
    ]),
  );
}

async function runtimeContainer(agentID) {
  const ids = lines(
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=${scopeLabel}=${project}`,
      "--filter",
      `label=io.antnest.agent-id=${agentID}`,
    ]),
  );
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  const runtimes = rows.filter(
    (row) => row.Config.Labels["io.antnest.managed"] === "runtime",
  );
  assert.equal(runtimes.length, 1, "expected one fixture-owned Runtime");
  assert.equal(runtimes[0].Config.Labels[scopeLabel], project);
  return runtimes[0];
}

export async function assertLivePeer(agentID, inspection, state, phase) {
  const network = await attachment(agentID);
  assert.equal(network.attachment_state, state, phase);
  if (state === "closed") {
    assert.equal(
      network.runtime_endpoint ?? null,
      null,
      "closed attachment retained peer",
    );
    assert.equal(
      network.tunnel_key_id ?? null,
      null,
      "closed attachment retained generation identity",
    );
    return { phase, state, version: network.attachment_resource_version };
  }
  const container = await runtimeContainer(agentID);
  const actualIP =
    container.NetworkSettings.Networks[
      process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK
    ]?.IPAddress;
  assert(actualIP, "Runtime has no management-network IPv4");
  assert.equal(inspection.runtime_endpoint, actualIP, "RC differs from Docker");
  assert.equal(
    network.runtime_endpoint,
    actualIP,
    "Egress differs from current Runtime",
  );
  assert.match(inspection.tunnel_key_id, /^rtk_[0-9a-f]{32}$/u);
  assert.equal(
    network.tunnel_key_id,
    inspection.tunnel_key_id,
    "Egress differs from current generation",
  );
  return {
    phase,
    state,
    version: network.attachment_resource_version,
    tunnel_key_id: inspection.tunnel_key_id,
    runtime_endpoint: actualIP,
  };
}

export async function restartWithNewPeer(agentID, inspect) {
  const before = await assertLivePeer(
    agentID,
    await inspect(),
    "open",
    "before_restart",
  );
  const container = await runtimeContainer(agentID);
  const management = process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK;
  const [network] = JSON.parse(
    await docker(["network", "inspect", management]),
  );
  assert.equal(network.Labels["com.docker.compose.project"], project);
  const subnet = network.IPAM.Config[0].Subnet;
  assert.match(subnet, /^10\.243\.\d+\.0\/24$/u);
  const prefix = subnet.slice(0, subnet.lastIndexOf(".") + 1);
  const used = new Set(
    Object.values(network.Containers ?? {}).map(
      (value) => value.IPv4Address.split("/")[0],
    ),
  );
  const address = Array.from(
    { length: 50 },
    (_, index) => `${prefix}${40 + index}`,
  ).find((value) => !used.has(value) && value !== before.runtime_endpoint);
  assert(address, "no free test address");
  const cryptoProof = await proveOldAddressCannotImpersonate(
    agentID,
    container,
    before,
  );
  await docker(["stop", "-t", "20", container.Id], true);
  await docker(["network", "disconnect", management, container.Id]);
  await docker([
    "network",
    "connect",
    "--ip",
    address,
    management,
    container.Id,
  ]);
  await docker(["start", container.Id], true);
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await inspect();
    if (current.phase === "running" && current.runtime_endpoint === address) {
      const bound = await attachment(agentID);
      if (
        bound.attachment_state === "open" &&
        bound.runtime_endpoint === address
      ) {
        assert(
          bound.attachment_resource_version > before.version,
          "rebind reused old CAS version",
        );
        return {
          ...(await assertLivePeer(
            agentID,
            current,
            "open",
            "restart_new_address",
          )),
          cryptoProof,
        };
      }
    }
    await delay(500);
  }
  throw new Error(
    "Controller did not rebind the restarted Runtime's current address",
  );
}

async function dataSnapshot(egress, predicate = () => true) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const rows = (await docker(["logs", egress.Id]))
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const value = rows
      .reverse()
      .find((x) => x["metric.event"] === "data_plane_snapshot" && predicate(x));
    if (value) return value;
    await delay(500);
  }
  throw new Error("authenticated packet metric snapshot did not converge");
}

async function proveOldAddressCannotImpersonate(agentID, runtime, before) {
  const binary = process.env.TEST_TUNNEL_WIRE_BINARY;
  assert(binary, "source-built test wire client required");
  const egress = await fixtureService("runtime-egress");
  const controller = await fixtureService("agent-controller");
  const network = await attachment(agentID);
  const spec = JSON.parse(
    runtime.Config.Env.find((x) => x.startsWith("ANTNEST_RUNTIME_SPEC=")).slice(
      "ANTNEST_RUNTIME_SPEC=".length,
    ),
  );
  const target = `${spec.network.egress_endpoint.ipv4}:${spec.network.egress_endpoint.port}`;
  const directory = resolve(
    process.env.TEST_EVIDENCE_DIRECTORY,
    "old-address-proof",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const frame = resolve(directory, "captured.bin");
  const attacker = project + "-old-address-holder";
  // Docker archive copies can address the underlying rootfs instead of a live
  // tmpfs. Keep this test-only executable and encrypted capture off /tmp.
  const runtimeBinary = "/var/tmp/antnest-wire-proof";
  const runtimeCapture = "/var/tmp/antnest-wire-captured.bin";
  let paused = false,
    detached = false;
  try {
    await docker(["cp", binary, runtime.Id + ":" + runtimeBinary]);
    const first = await dataSnapshot(egress);
    await docker([
      "exec",
      "--user",
      "0",
      runtime.Id,
      runtimeBinary,
      "/run/antnest-auth/tunnel.json",
      target,
      network.tunnel_ipv4,
      "192.0.2.1:9",
      "capture",
      runtimeCapture,
    ]);
    // This is a noncanonical probe (source port 40000): baseline policy denies it locally.
    const baseline = await dataSnapshot(
      egress,
      (x) => x["policy.denials"] > first["policy.denials"],
    );
    await docker(["cp", runtime.Id + ":" + runtimeCapture, frame]);
    // Only public metadata is extracted; the attacker receives neither victim secret.
    const publicKeys = JSON.parse(
      await docker([
        "exec",
        "--user",
        "0",
        runtime.Id,
        runtimeBinary,
        "/run/antnest-auth/tunnel.json",
        target,
        network.tunnel_ipv4,
        "192.0.2.1:9",
        "public",
        "-",
      ]),
    );
    const wrong = generateKeyPairSync("x25519");
    writeFileSync(
      resolve(directory, "keys.json"),
      JSON.stringify({
        key_id: before.tunnel_key_id,
        runtime_private_key: wrong.privateKey
          .export({ format: "der", type: "pkcs8" })
          .subarray(-32)
          .toString("base64url"),
        egress_public_key: publicKeys.egress_public_key,
        preshared_key: randomBytes(32).toString("base64url"),
      }),
      { mode: 0o600 },
    );
    await docker(["pause", controller.Id]);
    paused = true;
    await docker(["stop", "-t", "20", runtime.Id], true);
    await docker([
      "network",
      "disconnect",
      process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK,
      runtime.Id,
    ]);
    detached = true;
    await docker([
      "run",
      "-d",
      "--name",
      attacker,
      "--label",
      scopeLabel + "=" + project,
      "--network",
      process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK,
      "--ip",
      before.runtime_endpoint,
      "--cap-drop",
      "ALL",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${binary},dst=/proof/wire,readonly`,
      "--mount",
      `type=bind,src=${directory},dst=/proof/input,readonly`,
      "node:24.21.0-bookworm-slim",
      "node",
      "-e",
      "setInterval(()=>{},60000)",
    ]);
    const binding = await attachment(agentID);
    assert.equal(binding.runtime_endpoint, before.runtime_endpoint);
    assert.equal(binding.tunnel_key_id, before.tunnel_key_id);
    const command = (mode) => [
      "exec",
      attacker,
      "/proof/wire",
      "/proof/input/keys.json",
      target,
      network.tunnel_ipv4,
      "192.0.2.1:9",
      mode,
      "/proof/input/captured.bin",
    ];
    await docker(command("wrong"));
    await docker(command("saved"));
    const rejected = await dataSnapshot(
      egress,
      (x) =>
        x["tunnel.authentication_drops"] >
          baseline["tunnel.authentication_drops"] &&
        x["tunnel.replay_drops"] > baseline["tunnel.replay_drops"],
    );
    for (const name of ["policy.allows", "policy.denials", "flow.active"])
      assert.equal(
        rejected[name],
        baseline[name],
        `old-IP attack changed ${name}`,
      );
    return {
      old_ipv4_reassigned: true,
      old_binding_retained: true,
      wrong_key_rejected: true,
      captured_replay_rejected: true,
      no_policy_or_flow_effect: true,
    };
  } finally {
    await docker(["rm", "-f", "-v", attacker]).catch(() => {});
    if (detached)
      await docker([
        "network",
        "connect",
        "--ip",
        before.runtime_endpoint,
        process.env.ANTNEST_RUNTIME_MANAGEMENT_NETWORK,
        runtime.Id,
      ]);
    if (paused) await docker(["unpause", controller.Id]);
    await docker(["start", runtime.Id], true);
    await docker([
      "exec",
      "--user",
      "0",
      runtime.Id,
      "rm",
      "-f",
      runtimeBinary,
      runtimeCapture,
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function fixtureService(name) {
  assert.match(project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const ids = lines(
    await docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${name}`,
    ]),
  );
  assert.equal(ids.length, 1, "expected one fixture service");
  const [container] = JSON.parse(await docker(["inspect", ids[0]]));
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(container.Config.Labels["com.docker.compose.service"], name);
  return container;
}

export async function proveHealthDuringEgressOutage(agentID, readAgent) {
  const runtime = await runtimeContainer(agentID);
  const egress = await fixtureService("runtime-egress");
  const rc = await fixtureService("runtime-controller");
  let runtimePaused = false,
    egressPaused = false,
    committed;
  try {
    await docker(["pause", egress.Id]);
    egressPaused = true;
    await docker(["pause", runtime.Id]);
    runtimePaused = true;
    // Pause does not emit a supported health event. A normal RC restart
    // reconciles its actual inventory and produces the unhealthy observation.
    await docker(["restart", "-t", "20", rc.Id], true);
    for (let attempt = 0; attempt < 120; attempt++) {
      const current = await readAgent();
      if (
        current.runtime_state === "unhealthy" &&
        current.runtime_reason === "runtime_paused"
      ) {
        committed = current;
        break;
      }
      await delay(500);
    }
    assert(committed, "Egress outage blocked committed Runtime health");
    const [stillPaused] = JSON.parse(await docker(["inspect", egress.Id]));
    assert.equal(
      stillPaused.State.Paused,
      true,
      "Egress recovered before the health proof",
    );
  } finally {
    try {
      if (runtimePaused) await docker(["unpause", runtime.Id]);
    } finally {
      if (egressPaused) await docker(["unpause", egress.Id]);
    }
  }
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await readAgent();
    if (current.runtime_state === "available")
      return {
        health: committed.runtime_state,
        reason: committed.runtime_reason,
        egress_paused_during_commit: true,
        recovered: true,
      };
    await delay(500);
  }
  throw new Error("Runtime health did not recover after Egress resumed");
}
