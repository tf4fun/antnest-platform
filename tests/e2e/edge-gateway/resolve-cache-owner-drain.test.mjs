import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import * as lifecycle from "./resolve-cache-owner-drain.mjs";

test("a completed Session can collect after the real owner stop without inventing load responses", async () => {
  assert.equal(typeof lifecycle.createOwnerLifecycle, "function");
  const f = fixture();
  try {
    const owner = await lifecycle.createOwnerLifecycle({
      ...f.options,
      artifactPrefix: "session",
    });
    assert.equal(f.controls.clockCalls, undefined);
    assert.equal(owner.baseline["agent-ui"].running, true);
    let collected = 0;
    const result = await owner.collect(async (receipt) => {
      collected += 1;
      assert.equal(receipt.after["agent-ui"].running, false);
      assert.equal(f.calls.filter((args) => args[0] === "start").length, 0);
      for (const service of lifecycle.loadParticipantServices)
        if (service !== "agent-ui")
          assert.equal(receipt.after[service].running, true);
      lifecycle.inspectOwnerDrain(receipt);
      return { originalTraceIDs: ["original"] };
    });
    assert.deepEqual(result, { originalTraceIDs: ["original"] });
    assert.equal(collected, 1);
    assert.equal(f.calls.filter((args) => args[0] === "start").length, 1);
    const saved = JSON.parse(
      readFileSync(join(f.directory, "session-owner-drain.private.json")),
    );
    assert.equal(saved.restored, true);
    assert.equal(saved.acp_clock, undefined);
    assert(!f.calls.some((args) => args[0] === "exec"));
    await assert.rejects(() =>
      owner.collect(() => assert.fail("reused drain")),
    );
  } finally {
    f.cleanup();
  }
});

test("Session trace collection waits for the actual UI stop to settle", async () => {
  assert.equal(typeof lifecycle.createOwnerLifecycle, "function");
  const f = fixture();
  const stopEntered = Promise.withResolvers(),
    stopFinished = Promise.withResolvers();
  let collected = false;
  try {
    const owner = await lifecycle.createOwnerLifecycle({
      ...f.options,
      artifactPrefix: "session",
      docker: async (...args) => {
        if (args[0][0] === "stop") {
          stopEntered.resolve();
          await stopFinished.promise;
        }
        return f.options.docker(...args);
      },
    });
    const pending = owner.collect(async () => {
      collected = true;
    });
    await stopEntered.promise;
    assert.equal(collected, false);
    stopFinished.resolve();
    await pending;
    assert.equal(collected, true);
  } finally {
    stopFinished.resolve();
    f.cleanup();
  }
});

test("owner lifecycle preserves independent preparation before stop and in the durable receipt", async () => {
  const f = fixture();
  const clock = {
    container_id: "a".repeat(64),
    started_at: 10,
    received_at: 20,
  };
  const stages = [];
  try {
    const owner = await lifecycle.createOwnerLifecycle({
      ...f.options,
      artifactPrefix: "session",
    });
    await owner.collect(
      async (receipt) => {
        stages.push("collect");
        assert.deepEqual(receipt.acp_clock, clock);
      },
      {
        evidence: { acp_clock: clock },
        beforeDrain() {
          stages.push("before");
          assert(!f.calls.some((args) => args[0] === "stop"));
        },
        inspectDrain(receipt) {
          stages.push("inspect");
          assert.equal(receipt.after["agent-ui"].running, false);
          assert.deepEqual(receipt.acp_clock, clock);
        },
      },
    );
    assert.deepEqual(stages, ["before", "inspect", "collect"]);
    const saved = JSON.parse(
      readFileSync(join(f.directory, "session-owner-drain.private.json")),
    );
    assert.deepEqual(saved.acp_clock, clock);
    assert.equal(saved.restored, true);
  } finally {
    f.cleanup();
  }
});

test("owner preparation failure prevents the stop and collector", async () => {
  const f = fixture();
  try {
    const owner = await lifecycle.createOwnerLifecycle({
      ...f.options,
      artifactPrefix: "session",
    });
    await assert.rejects(
      () =>
        owner.collect(() => assert.fail("unprepared collection"), {
          beforeDrain() {
            throw new Error("clock preparation refused");
          },
        }),
      /clock preparation refused/u,
    );
    assert(!f.calls.some((args) => args[0] === "stop" || args[0] === "start"));
  } finally {
    f.cleanup();
  }
});

for (const warning of [
  "Bridge drain did not close cleanly",
  "Bridge shutdown failed",
  "Bridge telemetry shutdown failed",
  "Bridge authentication client shutdown failed",
])
  test(`Session cannot collect after a zero exit with ${warning}`, async () => {
    assert.equal(typeof lifecycle.createOwnerLifecycle, "function");
    const f = fixture();
    try {
      f.controls.logs = warning;
      const owner = await lifecycle.createOwnerLifecycle({
        ...f.options,
        artifactPrefix: "session",
      });
      await assert.rejects(() =>
        owner.collect(() => assert.fail("unclean drain admitted")),
      );
      assert.equal(f.calls.filter((args) => args[0] === "start").length, 1);
    } finally {
      f.cleanup();
    }
  });

test("cancelled collection still joins restoration with an independent cleanup budget", async () => {
  const f = fixture(),
    controller = new AbortController();
  let restoring = false,
    observations = 0;
  try {
    f.controls.start = () => {
      restoring = true;
      f.controls.neverHealthy = true;
    };
    f.controls.inspect = (state) => {
      if (
        restoring &&
        state.Config.Labels["com.docker.compose.service"] === "agent-ui" &&
        ++observations > 1
      )
        state.State.Health.Status = "healthy";
    };
    const owner = await lifecycle.createOwnerLifecycle({
      ...f.options,
      artifactPrefix: "session",
      signal: controller.signal,
      docker: (...args) => {
        controller.signal.throwIfAborted();
        return f.options.docker(...args);
      },
      cleanupDocker: f.options.docker,
    });
    await assert.rejects(() =>
      owner.collect(async () => {
        controller.abort(new Error("collection cancelled"));
      }),
    );
    assert(
      observations >= 2,
      "restoration never joined its healthy observation",
    );
    const saved = JSON.parse(
      readFileSync(join(f.directory, "session-owner-drain.private.json")),
    );
    assert.equal(saved.restored, true);
  } finally {
    f.cleanup();
  }
});

test("cancellation during UI restoration is reported only after the healthy join", async () => {
  const f = fixture(),
    controller = new AbortController();
  const failure = new Error("cancelled during restore start");
  try {
    f.controls.start = () => controller.abort(failure);
    const owner = await lifecycle.createOwnerLifecycle({
      ...f.options,
      artifactPrefix: "session",
      signal: controller.signal,
      cleanupDocker: f.options.docker,
    });
    await assert.rejects(
      () => owner.collect(async () => "collected"),
      (error) => error === failure || error.errors?.includes(failure),
    );
    const saved = JSON.parse(
      readFileSync(join(f.directory, "session-owner-drain.private.json")),
    );
    assert.equal(saved.restored, true);
  } finally {
    f.cleanup();
  }
});

function fixture() {
  const project = "antnest-lifecycle-abcdef12";
  const services = [
    "agent-ui",
    "edge-gateway",
    "identity-service",
    "agent-acp-service",
    "agent-controller",
    "runtime-controller",
    "jaeger",
    "runtime",
  ];
  const start = "2026-10-14T09:00:00.000000000Z";
  let time = 0;
  const calls = [],
    states = new Map(),
    images = {};
  for (const [index, service] of services.entries()) {
    const id = (index + 1).toString(16).repeat(64);
    const image = "sha256:" + id;
    images[service] = image;
    states.set(service, {
      Id: id,
      Image: image,
      RestartCount: 0,
      Config: {
        Env: ["FIXTURE=1"],
        Labels:
          service === "runtime"
            ? {
                "io.antnest.runtime-controller-scope": project,
                "io.antnest.managed": "runtime",
                "io.antnest.agent-id": "agent",
              }
            : {
                "com.docker.compose.project": project,
                "com.docker.compose.service": service,
              },
      },
      HostConfig: { ReadonlyRootfs: true },
      Mounts: [],
      State: {
        Running: true,
        Restarting: false,
        OOMKilled: false,
        ExitCode: 0,
        StartedAt: start,
        FinishedAt: "0001-01-01T00:00:00Z",
        Health: { Status: "healthy" },
      },
    });
  }
  const controls = { logs: "Agent UI Bridge listening", neverHealthy: false };
  const docker = async (args) => {
    calls.push(args);
    time += 1;
    if (args[0] === "compose") return states.get(args.at(-1)).Id;
    if (args[0] === "inspect") {
      const state =
        args[1] === "antnest-runtime-agent"
          ? states.get("runtime")
          : [...states.values()].find((row) => row.Id === args[1]);
      assert(state, "unexpected container");
      controls.inspect?.(state);
      return JSON.stringify([state]);
    }
    if (args[0] === "stop") {
      assert.equal(args.at(-1), states.get("agent-ui").Id);
      Object.assign(states.get("agent-ui").State, {
        Running: false,
        FinishedAt: new Date(Date.parse(start) + time).toISOString(),
      });
      controls.stopped?.(states);
      return args.at(-1);
    }
    if (args[0] === "logs") return controls.logs;
    if (args[0] === "start") {
      controls.start?.(states);
      const state = states.get("agent-ui").State;
      Object.assign(state, {
        Running: true,
        StartedAt: new Date(Date.parse(start) + time).toISOString(),
        Health: { Status: controls.neverHealthy ? "unhealthy" : "healthy" },
      });
      return args.at(-1);
    }
    assert.fail("unexpected Docker invocation");
  };
  const directory = mkdtempSync(join(temporaryStorageRoot(), "cache-drain-"));
  const options = {
    project,
    agentID: "agent",
    images,
    docker,
    compose: (args) => ["compose", ...args],
    output: directory,
    clockProbe: async ({ container, now }) => {
      controls.clockCalls = (controls.clockCalls ?? 0) + 1;
      if (controls.clockFailure) throw controls.clockFailure;
      const sample = {
        container_id: container,
        listener: "control",
        method: "GET",
        path: "/status",
        started_at: now(),
        received_at: now(),
        status: 200,
        server_date: new Date(Date.parse(start)).toUTCString(),
        ready: true,
        body_complete: true,
        body_bytes: 18,
        body_sha256: "a".repeat(64),
      };
      controls.clock?.(sample);
      controls.sample = sample;
      return sample;
    },
    now: () => time,
    wall: () => Date.parse(start) + time,
    wait: async (ms) => {
      time += ms;
    },
  };
  const wire = {
    started_at: 100,
    completed_at: 6100,
    requests: Array.from({ length: 100 }, (_, index) => ({
      body_complete: true,
      completed_at: index === 99 ? 6100 : 200 + index,
    })),
  };
  return {
    options,
    wire,
    states,
    controls,
    calls,
    directory,
    advance: (ms) => {
      time += ms;
    },
    measured: () => {
      time = 6100;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("load drain collects only after owned UI stops, then restores the same container", async () => {
  const f = fixture();
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    const measured = JSON.stringify(f.wire);
    const result = await owner.collect(f.wire, async (receipt) => {
      assert.equal(f.states.get("agent-ui").State.Running, false);
      lifecycle.inspectLoadOwnerDrain(f.wire, receipt);
      assert.equal(f.calls.filter((args) => args[0] === "stop").length, 1);
      assert.equal(f.calls.filter((args) => args[0] === "start").length, 0);
      return { complete: true };
    });
    assert.deepEqual(result, { complete: true });
    assert.equal(f.states.get("agent-ui").State.Running, true);
    assert.equal(JSON.stringify(f.wire), measured);
    const receipt = JSON.parse(
      readFileSync(join(f.directory, "load-owner-drain.private.json")),
    );
    assert.equal(receipt.restored, true);
    assert(
      receipt.restore.after["agent-ui"].started_at !==
        receipt.baseline["agent-ui"].started_at,
    );
  } finally {
    f.cleanup();
  }
});

test("Jaeger without a container healthcheck stays live across the drain", async () => {
  const f = fixture();
  try {
    delete f.states.get("jaeger").State.Health;
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    assert.equal(await owner.collect(f.wire, async () => true), true);
  } finally {
    f.cleanup();
  }
});

test("owner records the original ACP health probe before measured load and passes it to collection", async () => {
  const f = fixture();
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    assert.equal(f.controls.clockCalls, 1);
    assert.equal(
      f.controls.sample.container_id,
      f.states.get("agent-acp-service").Id,
    );
    const archived = JSON.parse(
      readFileSync(join(f.directory, "load-acp-clock.private.json")),
    );
    assert.deepEqual(archived, f.controls.sample);
    f.measured();
    await owner.collect(f.wire, async (receipt) => {
      assert.equal(
        receipt.acp_clock,
        f.controls.sample,
        "do not replace the actual probe receipt",
      );
      assert(receipt.acp_clock.received_at <= f.wire.started_at);
    });
    assert.equal(
      f.controls.clockCalls,
      1,
      "restoration must not create another clock probe",
    );
  } finally {
    f.cleanup();
  }
});

test("failed health probe aborts before measured load or owner stop", async () => {
  const f = fixture();
  const failure = new Error("real health failure");
  f.controls.clockFailure = failure;
  try {
    await assert.rejects(
      () => lifecycle.createLoadOwnerLifecycle(f.options),
      (error) => error === failure,
    );
    assert.equal(
      f.calls.filter((args) => ["stop", "start"].includes(args[0])).length,
      0,
    );
  } finally {
    f.cleanup();
  }
});

test("clock receipt from a different ACP container is rejected", async () => {
  const f = fixture();
  f.controls.clock = (sample) => {
    sample.container_id = "f".repeat(64);
  };
  try {
    await assert.rejects(
      () => lifecycle.createLoadOwnerLifecycle(f.options),
      /clock container/u,
    );
  } finally {
    f.cleanup();
  }
});

test("measurement cannot start before its ACP clock probe completes", async () => {
  const f = fixture();
  f.controls.clock = (sample) => {
    sample.received_at = 101;
    f.advance(101);
  };
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    await assert.rejects(
      () => owner.collect(f.wire, async () => assert.fail("must not collect")),
      /clock probe completed/u,
    );
    assert.equal(f.calls.filter((args) => args[0] === "stop").length, 0);
  } finally {
    f.cleanup();
  }
});

for (const [name, mutate] of [
  [
    "incomplete last response",
    (f) => {
      f.wire.requests.at(-1).body_complete = false;
    },
  ],
  [
    "uncompleted last body",
    (f) => {
      f.wire.requests.at(-1).completed_at = 6200;
    },
  ],
  [
    "UI image substitution",
    (f) => {
      f.states.get("agent-ui").Image = "sha256:" + "a".repeat(64);
    },
  ],
  [
    "UI config substitution",
    (f) => {
      f.states.get("agent-ui").Config.Env.push("ALTERED=1");
    },
  ],
  [
    "foreign project",
    (f) => {
      f.states.get("agent-ui").Config.Labels["com.docker.compose.project"] =
        "foreign";
    },
  ],
])
  test(`load drain rejects ${name} before stopping any process`, async () => {
    const f = fixture();
    try {
      const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
      f.measured();
      mutate(f);
      await assert.rejects(() =>
        owner.collect(f.wire, async () => assert.fail("must not collect")),
      );
      assert.equal(f.calls.filter((args) => args[0] === "stop").length, 0);
    } finally {
      f.cleanup();
    }
  });

for (const [name, stopped] of [
  [
    "UI still running",
    (states) => {
      states.get("agent-ui").State.Running = true;
    },
  ],
  [
    "UI forced exit",
    (states) => {
      states.get("agent-ui").State.ExitCode = 137;
    },
  ],
  [
    "UI OOM",
    (states) => {
      states.get("agent-ui").State.OOMKilled = true;
    },
  ],
  [
    "ACP restarted",
    (states) => {
      states.get("agent-acp-service").State.StartedAt =
        "2026-10-14T09:00:06.000Z";
    },
  ],
  [
    "Runtime stopped",
    (states) => {
      states.get("runtime").State.Running = false;
    },
  ],
])
  test(`load drain rejects ${name} without collecting incomplete traces`, async () => {
    const f = fixture();
    try {
      const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
      f.measured();
      f.controls.stopped = stopped;
      await assert.rejects(() =>
        owner.collect(f.wire, async () => assert.fail("must not collect")),
      );
    } finally {
      f.cleanup();
    }
  });

test("forced drain warning rejects an otherwise zero exit", async () => {
  const f = fixture();
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    f.controls.logs = "Bridge drain did not close cleanly";
    await assert.rejects(() =>
      owner.collect(f.wire, async () => assert.fail("must not collect")),
    );
    assert.equal(f.calls.filter((args) => args[0] === "start").length, 1);
  } finally {
    f.cleanup();
  }
});

test("collection and restoration failures are both retained", async () => {
  const f = fixture();
  const collection = new Error("collection failed"),
    restoration = new Error("restoration failed");
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    f.controls.start = () => {
      throw restoration;
    };
    await assert.rejects(
      () =>
        owner.collect(f.wire, async () => {
          throw collection;
        }),
      (error) => {
        assert(error instanceof AggregateError);
        assert.deepEqual(error.errors, [collection, restoration]);
        return true;
      },
    );
    assert.equal(f.calls.filter((args) => args[0] === "start").length, 1);
  } finally {
    f.cleanup();
  }
});

test("healthy restore must use the same image and configuration", async () => {
  const f = fixture();
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    f.controls.start = (states) => {
      states.get("agent-ui").Config.Env.push("ALTERED=1");
    };
    await assert.rejects(() =>
      owner.collect(f.wire, async () => ({ complete: true })),
    );
  } finally {
    f.cleanup();
  }
});

test("start alone does not prove healthy restoration", async () => {
  const f = fixture();
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    f.controls.neverHealthy = true;
    await assert.rejects(() =>
      owner.collect(f.wire, async () => ({ complete: true })),
    );
    assert(f.calls.filter((args) => args[0] === "inspect").length < 200);
  } finally {
    f.cleanup();
  }
});

for (const delayed of ["start", "healthy inspect"]) {
  test(`restoration rejects a late ${delayed} even if UI is healthy`, async () => {
    const f = fixture();
    try {
      const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
      f.measured();
      f.controls.start = () => {
        if (delayed === "start") f.advance(31000);
        else {
          let calls = 0;
          f.controls.inspect = (row) => {
            if (row.Id !== f.states.get("agent-ui").Id) return;
            row.State.Health.Status = ++calls === 1 ? "unhealthy" : "healthy";
            if (calls === 2) f.advance(31000);
          };
        }
      };
      await assert.rejects(() => owner.collect(f.wire, async () => true));
    } finally {
      f.cleanup();
    }
  });
}

test("final archive failure cannot replace collection and restore failures", async () => {
  const f = fixture();
  const collection = new Error("collection failed"),
    restoration = new Error("restoration failed");
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    f.controls.start = () => {
      throw restoration;
    };
    await assert.rejects(
      () =>
        owner.collect(f.wire, async () => {
          rmSync(f.directory, { recursive: true });
          writeFileSync(f.directory, "not a directory");
          throw collection;
        }),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors.length, 3);
        assert.equal(error.errors[0], collection);
        assert.equal(error.errors[1], restoration);
        assert(error.errors[2] instanceof Error);
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

function configuredParticipant(f) {
  const row = f.states.get("agent-ui");
  Object.assign(row.Config, {
    Env: ["FIXTURE=1", "PASSWORD=private-fixture-password"],
    Cmd: ["node", "server.mjs"],
    Entrypoint: ["/bin/sh", "-c"],
    Healthcheck: { Test: ["CMD", "node", "health.mjs"] },
  });
  Object.assign(row.HostConfig, { NanoCpus: 1000000000, Memory: 1000000 });
  row.Mounts = [
    {
      Type: "volume",
      Name: "owned-data",
      Source: "/volumes/owned-data",
      Destination: "/data",
      Driver: "local",
      Mode: "rw",
      RW: true,
      Propagation: "",
    },
    {
      Type: "bind",
      Source: "/private/fixture/config",
      Destination: "/config",
      Mode: "ro",
      RW: false,
      Propagation: "rprivate",
    },
  ];
  f.options.secrets = ["private-fixture-password"];
  return row;
}

test("Docker object-key and observed mount order changes preserve participant identity", async () => {
  const f = fixture();
  const row = configuredParticipant(f);
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    const reverseKeys = (value) =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, item]) => [key, reverseKeys(item)]),
            )
          : value;
    f.controls.inspect = (state) => {
      if (state !== row) return;
      state.Config = reverseKeys(state.Config);
      state.HostConfig = reverseKeys(state.HostConfig);
      state.Mounts = reverseKeys(state.Mounts).reverse();
    };
    f.measured();
    assert.equal(await owner.collect(f.wire, async () => true), true);
    const raw = readFileSync(
      join(f.directory, "load-owner-drain.private.json"),
      "utf8",
    );
    assert(!raw.includes("private-fixture-password"));
    const evidence = JSON.parse(raw);
    const before = evidence.baseline["agent-ui"],
      after = evidence.before["agent-ui"];
    assert.equal(before.configuration_sha256, after.configuration_sha256);
    assert.notEqual(
      before.configuration_serialized_sha256,
      after.configuration_serialized_sha256,
    );
    assert.deepEqual(
      before.configuration_fields_sha256,
      after.configuration_fields_sha256,
    );
    assert.equal(evidence.restored, true);
  } finally {
    f.cleanup();
  }
});

for (const [name, change] of [
  ["Env order", (row) => row.Config.Env.reverse()],
  ["Cmd order", (row) => row.Config.Cmd.reverse()],
  ["Entrypoint order", (row) => row.Config.Entrypoint.reverse()],
  ["Healthcheck Test order", (row) => row.Config.Healthcheck.Test.reverse()],
  ["HostConfig CPU", (row) => row.HostConfig.NanoCpus++],
  ["HostConfig memory", (row) => row.HostConfig.Memory++],
  [
    "unknown config field",
    (row) => {
      row.Config.FutureSetting = { enabled: true };
    },
  ],
  [
    "mount Source",
    (row) => {
      row.Mounts[0].Source = "/volumes/foreign";
    },
  ],
  [
    "mount Name",
    (row) => {
      row.Mounts[0].Name = "foreign";
    },
  ],
  [
    "mount RW",
    (row) => {
      row.Mounts[0].RW = false;
    },
  ],
  [
    "mount Mode",
    (row) => {
      row.Mounts[0].Mode = "ro";
    },
  ],
  [
    "mount Propagation",
    (row) => {
      row.Mounts[0].Propagation = "rshared";
    },
  ],
  [
    "mount Driver",
    (row) => {
      row.Mounts[0].Driver = "foreign";
    },
  ],
  [
    "mount Type",
    (row) => {
      row.Mounts[0].Type = "bind";
    },
  ],
  [
    "mount Destination",
    (row) => {
      row.Mounts[0].Destination = "/other";
    },
  ],
  [
    "unknown mount field",
    (row) => {
      row.Mounts[0].FutureSetting = true;
    },
  ],
  ["mount removal", (row) => row.Mounts.pop()],
  [
    "mount addition",
    (row) => row.Mounts.push({ ...row.Mounts[0], Destination: "/added" }),
  ],
]) {
  test(`configuration rejection archives both observations for changed ${name}`, async () => {
    const f = fixture();
    const row = configuredParticipant(f);
    try {
      const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
      const baselineRaw = readFileSync(
        join(f.directory, "load-owner-baseline.private.json"),
        "utf8",
      );
      assert(!baselineRaw.includes("private-fixture-password"));
      f.measured();
      change(row);
      await assert.rejects(
        () =>
          owner.collect(f.wire, async () => assert.fail("must not collect")),
        /agent-ui.*configuration_sha256/u,
      );
      assert.equal(
        f.calls.filter((args) => ["stop", "start"].includes(args[0])).length,
        0,
      );
      const raw = readFileSync(
        join(f.directory, "load-owner-drain.private.json"),
        "utf8",
      );
      assert(!raw.includes("private-fixture-password"));
      const evidence = JSON.parse(raw);
      assert.notEqual(
        evidence.baseline["agent-ui"].configuration_sha256,
        evidence.before["agent-ui"].configuration_sha256,
      );
      assert.notDeepEqual(
        evidence.baseline["agent-ui"].configuration_fields_sha256,
        evidence.before["agent-ui"].configuration_fields_sha256,
      );
      assert.equal(
        evidence.requested_at,
        undefined,
        "must not claim a stop was requested",
      );
      assert.equal(evidence.restored, false);
      assert(
        evidence.failures.some((message) =>
          /agent-ui.*configuration_sha256/u.test(message),
        ),
      );
    } finally {
      f.cleanup();
    }
  });
}

test("duplicate observed mount destinations reject before the load starts", async () => {
  const f = fixture();
  const row = configuredParticipant(f);
  row.Mounts.push({ ...row.Mounts[0] });
  try {
    await assert.rejects(
      () => lifecycle.createLoadOwnerLifecycle(f.options),
      /duplicate mount destination/u,
    );
    assert.equal(f.controls.clockCalls ?? 0, 0);
  } finally {
    f.cleanup();
  }
});

test("failed diagnostic archive retains the actual pre-stop configuration failure", async () => {
  const f = fixture();
  const row = configuredParticipant(f);
  try {
    const owner = await lifecycle.createLoadOwnerLifecycle(f.options);
    f.measured();
    row.HostConfig.Memory++;
    rmSync(f.directory, { recursive: true });
    writeFileSync(f.directory, "not a directory");
    await assert.rejects(
      () => owner.collect(f.wire, async () => assert.fail("must not collect")),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(
          error.errors[0].message,
          /agent-ui.*configuration_sha256/u,
        );
        assert(error.errors[1] instanceof Error);
        return true;
      },
    );
    assert.equal(
      f.calls.filter((args) => ["stop", "start"].includes(args[0])).length,
      0,
    );
  } finally {
    f.cleanup();
  }
});
