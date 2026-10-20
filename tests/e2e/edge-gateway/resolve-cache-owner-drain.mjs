import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import {
  probeACPClock,
  inspectACPClockReceipt,
} from "./resolve-cache-clock.mjs";
import {
  evidenceDirectory,
  writeEvidenceFile,
} from "../../support/storage.mjs";

export const loadParticipantServices = [
  "agent-ui",
  "edge-gateway",
  "identity-service",
  "agent-acp-service",
  "agent-controller",
  "runtime-controller",
  "jaeger",
  "runtime",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) => hash(JSON.stringify(canonical(value)));
const fields = (value) =>
  Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, digest(value[key])]),
  );

function configuration(row) {
  // Docker's observed mount list is unordered. Configuration arrays such as
  // Env, Cmd, Entrypoint and Healthcheck.Test retain their original order.
  assert(Array.isArray(row.Mounts), "load participant mount list missing");
  const destinations = row.Mounts.map((mount) => mount.Destination);
  assert(
    destinations.every((value) => typeof value === "string" && value.length),
  );
  assert.equal(
    new Set(destinations).size,
    destinations.length,
    "duplicate mount destination",
  );
  const mounts = [...row.Mounts].sort((a, b) =>
    a.Destination.localeCompare(b.Destination),
  );
  const raw = { config: row.Config, host: row.HostConfig, mounts: row.Mounts };
  return {
    configuration_sha256: digest({ ...raw, mounts }),
    configuration_serialized_sha256: hash(JSON.stringify(raw)),
    // Field digests identify changes without retaining passwords or other
    // values from Docker Config.Env, labels, command arguments or mount paths.
    configuration_fields_sha256: {
      config: fields(row.Config),
      host: fields(row.HostConfig),
      mounts: mounts.map(fields),
    },
  };
}
const finite = (value) =>
  assert(Number.isFinite(value), "lifecycle observation time missing");
const timestamp = (value) => {
  const result = Date.parse(value);
  finite(result);
  return result;
};

function sameContainer(before, after) {
  for (const name of [
    "id",
    "project",
    "service",
    "image",
    "configuration_sha256",
    "restart_count",
  ])
    assert.equal(
      after[name],
      before[name],
      `load participant ${before.service} ${name} changed`,
    );
}
function normal(state, running) {
  assert.equal(
    state.running,
    running,
    "unexpected load participant running state",
  );
  assert.equal(state.restarting, false);
  assert.equal(state.oom_killed, false);
  assert.equal(state.exit_code, 0, "load participant did not exit normally");
  if (running && !(state.service === "jaeger" && state.health === undefined))
    assert.equal(state.health, "healthy", "load participant is not healthy");
  finite(state.at);
  finite(state.observed_at_ms);
  timestamp(state.started_at);
}
function sameLive(baseline, observed) {
  for (const service of loadParticipantServices) {
    sameContainer(baseline[service], observed[service]);
    assert.equal(
      observed[service].started_at,
      baseline[service].started_at,
      "load peer process changed",
    );
    normal(observed[service], true);
  }
}
function participants(snapshot, project) {
  assert(
    snapshot && typeof snapshot === "object",
    "participant snapshot missing",
  );
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [...loadParticipantServices].sort(),
  );
  assert(typeof project === "string" && project.length > 0);
  const ids = [];
  for (const service of loadParticipantServices) {
    const state = snapshot[service];
    assert.equal(state.service, service);
    assert.equal(state.project, project);
    assert.match(state.id ?? "", /^[a-f0-9]{64}$/u);
    assert.match(state.image ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.match(state.configuration_sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert(
      Number.isSafeInteger(state.restart_count) && state.restart_count >= 0,
    );
    ids.push(state.id);
  }
  assert.equal(new Set(ids).size, loadParticipantServices.length);
}

export function inspectLoadOwnerRestoration(evidence) {
  const restore = evidence?.restore;
  assert(restore, "actual owner restoration receipt missing");
  participants(evidence.baseline, evidence.project);
  participants(evidence.after, evidence.project);
  participants(restore.after, evidence.project);
  finite(restore.requested_at);
  finite(restore.completed_at);
  finite(evidence.stopped_at);
  assert(
    restore.requested_at >= evidence.stopped_at &&
      restore.completed_at >= restore.requested_at &&
      restore.completed_at - restore.requested_at <= 30000,
    "UI restoration exceeded its deadline",
  );
  for (const service of loadParticipantServices) {
    const baseline = evidence.baseline[service],
      after = restore.after[service];
    sameContainer(baseline, after);
    normal(after, true);
    assert(evidence.after[service].at <= restore.requested_at);
    assert(
      after.at >= restore.requested_at && after.at <= restore.completed_at,
    );
    if (service !== "agent-ui")
      assert.equal(
        after.started_at,
        baseline.started_at,
        "load peer restarted during restoration",
      );
  }
  const ui = restore.after["agent-ui"];
  assert(
    timestamp(ui.started_at) >
      timestamp(evidence.after["agent-ui"].finished_at) &&
      timestamp(ui.started_at) <= ui.observed_at_ms,
    "UI process was not restarted after its measured exit",
  );
  return evidence;
}
function measured(wire, baseline, at) {
  assert(
    Array.isArray(wire.requests) && wire.requests.length === 100,
    "100 load responses required before drain",
  );
  finite(wire.started_at);
  finite(wire.completed_at);
  finite(at);
  assert(
    wire.started_at <= wire.completed_at && wire.completed_at <= at,
    "drain overlaps the measured load",
  );
  assert(
    wire.requests.every(
      (row) =>
        row.body_complete === true &&
        Number.isFinite(row.completed_at) &&
        row.completed_at <= wire.completed_at,
    ),
    "load response body is incomplete",
  );
  for (const state of Object.values(baseline))
    assert(
      state.at <= wire.started_at,
      "participant baseline followed load dispatch",
    );
}

export function inspectOwnerDrain(evidence) {
  assert(
    evidence && evidence.baseline && evidence.before && evidence.after,
    "actual load owner drain receipt missing",
  );
  for (const snapshot of [evidence.baseline, evidence.before, evidence.after])
    participants(snapshot, evidence.project);
  for (const state of Object.values(evidence.baseline)) normal(state, true);
  sameLive(evidence.baseline, evidence.before);
  finite(evidence.requested_at);
  finite(evidence.stopped_at);
  assert(
    evidence.requested_at < evidence.stopped_at &&
      evidence.stopped_at - evidence.requested_at <= 30000,
    "UI stop did not finish within its grace period",
  );
  for (const service of loadParticipantServices) {
    const before = evidence.before[service],
      after = evidence.after[service];
    assert.equal(before.project, evidence.project);
    assert.equal(before.service, service);
    assert(
      before.at <= evidence.requested_at && after.at >= evidence.stopped_at,
      "invalid participant observation order",
    );
    sameContainer(before, after);
    assert.equal(
      after.started_at,
      before.started_at,
      "load peer process changed during drain",
    );
    normal(after, service !== "agent-ui");
  }
  const before = evidence.before["agent-ui"],
    after = evidence.after["agent-ui"];
  const finished = timestamp(after.finished_at);
  assert(
    timestamp(before.started_at) < finished,
    "UI termination time missing",
  );
  finite(evidence.requested_at_ms);
  assert(
    evidence.requested_at_ms <= finished && finished <= after.observed_at_ms,
    "UI exit does not belong to the actual stop interval",
  );
  assert.equal(evidence.log_checked, true, "UI stop log was not checked");
  assert.equal(evidence.forced_drain, false, "UI drain was forced");
  assert.match(evidence.log_sha256 ?? "", /^[a-f0-9]{64}$/u);
  return evidence;
}

export function inspectLoadOwnerDrain(wire, evidence) {
  inspectOwnerDrain(evidence);
  inspectClockBeforeLoad(wire, evidence.baseline, evidence.acp_clock);
  measured(wire, evidence.baseline, evidence.requested_at);
  return evidence;
}

function inspectClockBeforeLoad(wire, baseline, clock) {
  inspectACPClockReceipt(clock);
  assert.equal(
    clock.container_id,
    baseline["agent-acp-service"].id,
    "clock container differs",
  );
  assert(
    clock.started_at >= baseline["agent-acp-service"].at,
    "clock probe preceded baseline",
  );
  assert(
    clock.received_at <= wire.started_at,
    "load started before its ACP clock probe completed",
  );
}

// All lifecycle operations target the containers captured at setup.
// No workspace probe can initialize or revive an owner here.
// This proves the container lifecycle only. The collector must separately
// require the owner's actual protocol cleanup receipt; UI exit is not a join
// of the SDK's asynchronous HTTP DELETE.
async function createOwnerLifecycleCore({
  docker,
  cleanupDocker = docker,
  compose,
  project,
  agentID,
  images,
  output,
  secrets = [],
  signal,
  artifactPrefix = "load",
  now = () => performance.now(),
  wall = Date.now,
  wait = delay,
}) {
  output = evidenceDirectory(output);
  assert(output, "durable owner lifecycle archive required");
  assert.match(artifactPrefix, /^[a-z][a-z0-9-]*$/u);
  const ids = {},
    baseline = {};
  const mark = () => ({ at: now(), observed_at_ms: wall() });
  const read = async (service, id, client = docker) => {
    const rows = JSON.parse(await client(["inspect", id]));
    assert.equal(rows.length, 1, "load participant missing or duplicated");
    const [row] = rows,
      labels = row.Config.Labels ?? {};
    assert.match(row.Id, /^[a-f0-9]{64}$/u);
    if (ids[service])
      assert.equal(row.Id, ids[service], "load participant replaced");
    if (service === "runtime") {
      assert.equal(labels["io.antnest.runtime-controller-scope"], project);
      assert.equal(labels["io.antnest.agent-id"], agentID);
      assert.equal(labels["io.antnest.managed"], "runtime");
    } else {
      assert.equal(labels["com.docker.compose.project"], project);
      assert.equal(labels["com.docker.compose.service"], service);
    }
    assert.match(
      images[service] ?? "",
      /^sha256:[a-f0-9]{64}$/u,
      "selected participant image missing",
    );
    assert.equal(
      row.Image,
      images[service],
      "load participant selected image differs",
    );
    return {
      id: row.Id,
      project,
      service,
      image: row.Image,
      ...configuration(row),
      restart_count: row.RestartCount,
      running: row.State.Running,
      restarting: row.State.Restarting,
      oom_killed: row.State.OOMKilled,
      exit_code: row.State.ExitCode,
      health: row.State.Health?.Status,
      started_at: row.State.StartedAt,
      finished_at: row.State.FinishedAt,
      ...mark(),
    };
  };
  const snapshot = async (client = docker) => {
    const result = {};
    for (const service of loadParticipantServices)
      result[service] = await read(service, ids[service], client);
    return result;
  };
  for (const service of loadParticipantServices) {
    assert(!signal?.aborted, "load owner setup cancelled");
    const id =
      service === "runtime"
        ? `antnest-runtime-${agentID}`
        : await docker(compose(["ps", "-q", service]));
    const row = await read(service, id);
    normal(row, true);
    ids[service] = row.id;
    baseline[service] = row;
  }
  assert.equal(
    new Set(Object.values(ids)).size,
    loadParticipantServices.length,
  );
  const baselineRaw = JSON.stringify(
    { project, agent_id: agentID, baseline },
    null,
    2,
  );
  assertSecretFree(baselineRaw, secrets);
  writeEvidenceFile(
    output,
    `${artifactPrefix}-owner-baseline.private.json`,
    baselineRaw,
  );
  let used = false;
  return {
    baseline,
    output,
    async collect(collect, preparation = {}) {
      assert.equal(used, false, "load owner lifecycle already used");
      used = true;
      const evidence = {
        project,
        agent_id: agentID,
        baseline,
        ...preparation.evidence,
        restored: false,
      };
      const save = () => {
        const raw = JSON.stringify(evidence, null, 2);
        assertSecretFree(raw, secrets);
        writeEvidenceFile(
          output,
          `${artifactPrefix}-owner-drain.private.json`,
          raw,
        );
      };
      let result;
      let stopAttempted = false;
      const errors = [];
      try {
        preparation.beforeDrain?.();
        evidence.before = await snapshot();
        sameLive(baseline, evidence.before);
        assert(!signal?.aborted, "load owner drain cancelled");
        evidence.requested_at = now();
        evidence.requested_at_ms = wall();
        save();
        stopAttempted = true;
        await docker(["stop", "--time", "30", ids["agent-ui"]]);
        evidence.stopped_at = now();
        evidence.after = await snapshot();
        const logs = await docker(
          [
            "logs",
            "--timestamps",
            "--since",
            baseline["agent-ui"].started_at,
            ids["agent-ui"],
          ],
          false,
          { captureStderr: true },
        );
        assertSecretFree(logs, secrets);
        writeEvidenceFile(
          output,
          `${artifactPrefix}-owner-stop.private.log`,
          logs,
        );
        evidence.log_checked = true;
        evidence.log_sha256 = hash(logs);
        evidence.forced_drain =
          /Bridge (?:drain did not close cleanly|(?:telemetry |authentication client )?shutdown failed)/u.test(
            logs,
          );
        save();
        inspectOwnerDrain(evidence);
        preparation.inspectDrain?.(evidence);
        result = await collect(evidence);
        signal?.throwIfAborted();
      } catch (error) {
        errors.push(error);
      } finally {
        if (stopAttempted)
          try {
            evidence.restore = { requested_at: now() };
            const deadline = evidence.restore.requested_at + 30000;
            const cleanupSignal = AbortSignal.timeout(30000);
            const restoringDocker = (args, long = false, options = {}) => {
              const timeoutMS = Math.ceil(deadline - now());
              assert(timeoutMS > 0, "UI restoration exceeded its deadline");
              return cleanupDocker(args, long, {
                ...options,
                signal: cleanupSignal,
                timeoutMS,
              });
            };
            await restoringDocker(["start", ids["agent-ui"]]);
            let ui;
            do {
              ui = await read("agent-ui", ids["agent-ui"], restoringDocker);
              sameContainer(baseline["agent-ui"], ui);
              assert(now() <= deadline, "UI restoration exceeded its deadline");
              if (ui.running && ui.health === "healthy") break;
              assert(now() < deadline, "UI restoration did not become healthy");
              await wait(250, undefined, { signal: cleanupSignal });
            } while (true);
            const after = await snapshot(restoringDocker);
            evidence.restore.after = after;
            evidence.restore.completed_at = now();
            inspectLoadOwnerRestoration(evidence);
            evidence.restored = true;
          } catch (error) {
            errors.push(error);
          }
        if (signal?.aborted && !errors.includes(signal.reason))
          errors.push(signal.reason);
        evidence.failures = errors.map((error) => {
          try {
            assertSecretFree(error.message, secrets);
            return error.message;
          } catch {
            return "owner lifecycle failure contains private diagnostics";
          }
        });
        try {
          save();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        if (!stopAttempted && errors.length === 1) throw errors[0];
        throw new AggregateError(
          errors,
          `Bridge ${artifactPrefix} owner lifecycle failed`,
        );
      }
      return result;
    },
  };
}

export async function createOwnerLifecycle(options) {
  const owner = await createOwnerLifecycleCore(options);
  return {
    baseline: owner.baseline,
    collect: (collect, preparation) => owner.collect(collect, preparation),
  };
}

export async function createLoadOwnerLifecycle({
  environment,
  clockProbe = probeACPClock,
  now = () => performance.now(),
  ...options
}) {
  const owner = await createOwnerLifecycleCore({
    ...options,
    artifactPrefix: "load",
    now,
  });
  const baseline = owner.baseline;
  const clock = await clockProbe({
    container: baseline["agent-acp-service"].id,
    environment,
    signal: options.signal,
    now,
  });
  inspectACPClockReceipt(clock);
  assert.equal(
    clock.container_id,
    baseline["agent-acp-service"].id,
    "clock container differs",
  );
  assert(clock.started_at >= baseline["agent-acp-service"].at);
  assert(clock.received_at <= now(), "clock probe receipt is from the future");
  const clockRaw = JSON.stringify(clock, null, 2);
  assertSecretFree(clockRaw, options.secrets ?? []);
  writeEvidenceFile(owner.output, "load-acp-clock.private.json", clockRaw);
  return {
    baseline,
    collect: (wire, collect) =>
      owner.collect(collect, {
        evidence: { acp_clock: clock },
        beforeDrain() {
          inspectClockBeforeLoad(wire, baseline, clock);
          measured(wire, baseline, now());
        },
        inspectDrain(evidence) {
          inspectLoadOwnerDrain(wire, evidence);
        },
      }),
  };
}
