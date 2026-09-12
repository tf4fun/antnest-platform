import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { composeArgs, lines } from "./docker.mjs";
import { privateIPv4 } from "./network-evidence.mjs";

export function guardRules(ip) {
  privateIPv4(ip);
  const source = 'iifname "antnest-egress0" ip saddr 100.64.0.0/10';
  return `table ip c3_guard {
    chain forward { type filter hook forward priority 10; policy accept;
      ${source} ip daddr != ${ip} drop
      ${source} meta l4proto != tcp drop
      ${source} tcp dport != 8080 drop
    }
  }`;
}
export function redirectRules(ip) {
  privateIPv4(ip);
  return `table ip c3_redirect {
    chain prerouting { type nat hook prerouting priority -110; policy accept;
      iifname "antnest-egress0" ip saddr 100.64.0.0/10 ip daddr 1.1.1.1 tcp dport 18080 dnat to ${ip}:8080
    }
  }`;
}
export function flowTuples(text, source) {
  return text.split("\n").flatMap((line) => {
    const match = line.match(
      /^tcp\s+6\s+\d+\s+(\w+)\s+src=(\S+) dst=(\S+) sport=(\d+) dport=(\d+)/,
    );
    if (
      !match ||
      match[2] !== source ||
      match[3] !== "1.1.1.1" ||
      match[5] !== "18080"
    )
      return [];
    return [
      {
        source,
        port: Number(match[4]),
        destination: match[3],
        targetPort: Number(match[5]),
        state: match[1],
      },
    ];
  });
}
export function physicalIdentity({ container, volume, agent }) {
  return {
    id: container.Id,
    image: container.Image,
    started: container.State.StartedAt,
    restarts: container.RestartCount,
    config: container.Config,
    mounts: container.Mounts,
    volume,
    configuration: agent.configuration,
    runtime: agent.runtime,
    execution: agent.executable_execution_revision,
  };
}

export function assertProducerStopped(container, project) {
  assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  assert.equal(container.State.Running, false);
  assert.equal(container.State.OOMKilled, false);
  assert.equal(
    container.State.ExitCode,
    0,
    "trace producer did not finish graceful shutdown",
  );
}

export function assertRuntimeExited(events, id, project) {
  for (const event of events) {
    assert.equal(event.Type, "container");
    assert.equal(event.Actor.ID, id);
    assert.equal(
      event.Actor.Attributes["io.antnest.runtime-controller-scope"],
      project,
    );
    assert.notEqual(event.Action, "oom");
    if (event.Action === "kill")
      assert.notEqual(event.Actor.Attributes.signal, "9");
  }
  const deaths = events.filter((e) => e.Action === "die");
  assert.equal(deaths.length, 1, "missing or repeated Runtime exit");
  assert.equal(
    deaths[0].Actor.Attributes.exitCode,
    "0",
    "Runtime telemetry shutdown was interrupted",
  );
  for (const action of ["stop", "destroy"])
    assert.equal(events.filter((e) => e.Action === action).length, 1);
}

export async function runtimeExitEvidence(config, docker, id, since) {
  const output = await docker([
    "events",
    "--since",
    since,
    "--until",
    new Date().toISOString(),
    "--filter",
    "type=container",
    "--filter",
    `container=${id}`,
    "--format",
    "{{json .}}",
  ]);
  const events = output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assertRuntimeExited(events, id, config.project);
}

export async function flushTraceProducers(config, docker) {
  const services = [
    "edge-gateway",
    "admin-console",
    "agent-acp-service",
    "agent-controller",
    "runtime-controller",
    "runtime-egress",
    "identity-service",
  ];
  await docker(
    composeArgs(config.project, ["stop", "-t", "30", ...services]),
    true,
  );
  const ids = lines(
    await docker(composeArgs(config.project, ["ps", "-a", "-q", ...services])),
  );
  assert.equal(ids.length, services.length);
  for (const container of JSON.parse(await docker(["inspect", ...ids])))
    assertProducerStopped(container, config.project);
  return services.length;
}
export function tunnelIP(container) {
  const entry = container.Config.Env.find((v) =>
    v.startsWith("ANTNEST_RUNTIME_SPEC="),
  );
  assert(entry, "Runtime spec missing");
  const ip = JSON.parse(entry.slice(entry.indexOf("=") + 1)).network
    .tunnel_ipv4;
  assert(isIPv4(ip) && ip.startsWith("100.64."));
  return ip;
}
export async function networkFixture(config, docker) {
  const container = async (name) => {
    const ids = lines(
      await docker(
        composeArgs(config.project, [
          "-f",
          "scripts/lifecycle-closeout/network.compose.yaml",
          "ps",
          "-q",
          name,
        ]),
      ),
    );
    assert.equal(ids.length, 1);
    const item = JSON.parse(await docker(["inspect", ids[0]]))[0];
    assert.equal(
      item.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    return item;
  };
  const target = await container("network-target"),
    egress = await container("runtime-egress");
  const network = `${config.project}_egress`;
  assert.deepEqual(Object.keys(target.NetworkSettings.Networks), [network]);
  const ip = privateIPv4(target.NetworkSettings.Networks[network].IPAddress);
  const peer = privateIPv4(egress.NetworkSettings.Networks[network].IPAddress);
  for (const rules of [guardRules(ip), redirectRules(ip)])
    await docker([
      "exec",
      egress.Id,
      "sh",
      "-c",
      "printf '%s' \"$1\" | nft -f -",
      "sh",
      rules,
    ]);
  const control = async (path = "/status", method = "GET") => {
    assert(path === "/status" || /^\/push\/[a-z0-9-]{6,64}$/.test(path));
    assert(["GET", "POST"].includes(method));
    try {
      return JSON.parse(
        await docker([
          "exec",
          egress.Id,
          "curl",
          "--noproxy",
          "*",
          "--fail",
          "--silent",
          "--max-time",
          "3",
          "--request",
          method,
          `http://${ip}:8081${path}`,
        ]),
      );
    } catch (error) {
      const state = JSON.parse(await docker(["inspect", target.Id]))[0];
      throw new Error(
        `target control failed: running=${state.State.Running} oom=${state.State.OOMKilled} restarts=${state.RestartCount}`,
        { cause: error },
      );
    }
  };
  return {
    ip,
    peer,
    control,
    conntrack: async (source) =>
      flowTuples(
        await docker(["exec", egress.Id, "conntrack", "-L", "-p", "tcp"]),
        source,
      ),
  };
}
