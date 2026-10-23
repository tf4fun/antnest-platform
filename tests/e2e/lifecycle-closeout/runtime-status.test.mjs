import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeControllerRead, runtimeStatus } from "./runtime-status.mjs";
import * as runtimeStatusModule from "./runtime-status.mjs";

const project = "antnest-lifecycle-1234abcd";

function fakeDocker(accepted) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "compose") return "rc-id\n";
    if (args[0] === "inspect") return JSON.stringify([{ Id: "rc-id" }]);
    if (args[0] === "exec" && args[1] === "rc-id")
      return "sender-one\nsender-two\n";
    if (args[0] === "exec" && args[1] === "-e") {
      assert.equal(args[3], "runtime-id");
      if (args[2] === `ANTNEST_RUNTIME_STATUS_BEARER=${accepted}`)
        return JSON.stringify({ status: "ready", execution_id: "process" });
      throw new Error("Docker exec failed (22)");
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { docker, calls };
}

test("Runtime status is read from the live Runtime with a Controller credential", async () => {
  const { docker, calls } = fakeDocker("sender-two");
  assert.deepEqual(await runtimeStatus(docker, project, "runtime-id"), {
    status: "ready",
    execution_id: "process",
  });
  const reads = calls.filter((args) => args[1] === "-e");
  assert.equal(reads.length, 2);
  for (const args of reads) {
    assert.equal(args.at(-1).includes("sender-"), false);
    assert.match(args.at(-1), /http:\/\/127\.0\.0\.1:8093\/status$/u);
  }
});

function stage3Docker({ ids = ["rc-id"], change = (rows) => rows } = {}) {
  const stage3Project = "antnest-stage3-e2e-3845";
  const { docker: base, calls } = fakeDocker("sender-two");
  const discovery = [];
  const docker = async (args, ...options) => {
    if (args[0] === "ps") {
      discovery.push(args);
      assert.deepEqual(args, [
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${stage3Project}`,
        "--filter",
        "label=com.docker.compose.service=runtime-controller",
      ]);
      return ids.join("\n");
    }
    if (args[0] === "inspect") {
      discovery.push(args);
      assert.deepEqual(args, ["inspect", "rc-id"]);
      return JSON.stringify(
        change([
          {
            Id: "rc-id",
            Config: {
              Labels: {
                "com.docker.compose.project": stage3Project,
                "com.docker.compose.service": "runtime-controller",
              },
            },
          },
        ]),
      );
    }
    return base(args, ...options);
  };
  return { docker, calls, discovery, project: stage3Project };
}

test("Stage3 Runtime status discovers exactly its labeled Controller without a lifecycle Compose profile", async () => {
  const { docker, calls, discovery, project: stage3Project } = stage3Docker();
  assert.deepEqual(await runtimeStatus(docker, stage3Project, "runtime-id"), {
    status: "ready",
    execution_id: "process",
  });
  assert.equal(discovery.length, 2);
  assert.equal(calls.filter((args) => args[1] === "-e").length, 2);
  assert(!calls.some((args) => args[0] === "compose"));
});

for (const [name, options] of [
  ["missing", { ids: [] }],
  ["ambiguous", { ids: ["rc-id", "other-id"] }],
  [
    "foreign project",
    {
      change: (rows) => {
        rows[0].Config.Labels["com.docker.compose.project"] = "another-project";
        return rows;
      },
    },
  ],
  [
    "wrong service",
    {
      change: (rows) => {
        rows[0].Config.Labels["com.docker.compose.service"] =
          "agent-controller";
        return rows;
      },
    },
  ],
  ["replaced identity", { change: (rows) => [{ ...rows[0], Id: "other-id" }] }],
  ["duplicate inspection", { change: (rows) => [...rows, ...rows] }],
]) {
  test(`Stage3 Runtime status rejects ${name} Controller before reading credentials`, async () => {
    const { docker, calls, project: stage3Project } = stage3Docker(options);
    await assert.rejects(runtimeStatus(docker, stage3Project, "runtime-id"));
    assert.equal(calls.length, 0);
  });
}

test("Runtime status rejects an arbitrary project before container discovery", async () => {
  const { docker, calls, discovery } = stage3Docker();
  await assert.rejects(runtimeStatus(docker, "production", "runtime-id"));
  assert.equal(discovery.length, 0);
  assert.equal(calls.length, 0);
});

test("Runtime status fails without leaking rejected credentials", async () => {
  const { docker } = fakeDocker("none");
  await assert.rejects(
    runtimeStatus(docker, project, "runtime-id"),
    (error) => !error.message.includes("sender-"),
  );
});

test("an invalid successful status response cannot be hidden by another credential", async () => {
  const { docker: base } = fakeDocker("sender-two");
  let attempts = 0;
  const docker = async (args) => {
    if (args[1] === "-e" && ++attempts === 1) return "invalid-status-body";
    return base(args);
  };
  await assert.rejects(runtimeStatus(docker, project, "runtime-id"));
  assert.equal(attempts, 1);
});

test("prepared Runtime status reuses only the accepted credential while sampling the live process again", async () => {
  const { docker, calls } = fakeDocker("sender-two");
  const prepared = await runtimeStatusModule.prepareRuntimeStatus(
    docker,
    project,
    "runtime-id",
  );
  assert.equal(prepared.status.execution_id, "process");
  const count = calls.length;
  const next = [];
  const result = await prepared.read(
    async (args, long, options) => {
      next.push(args);
      assert.equal(args[2], "ANTNEST_RUNTIME_STATUS_BEARER=sender-two");
      assert(options.signal instanceof AbortSignal);
      return JSON.stringify({
        status: "ready",
        execution_id: "changed-process",
      });
    },
    { timeoutMS: 500 },
  );
  assert.equal(result.execution_id, "changed-process");
  assert.equal(next.length, 1);
  assert.equal(calls.length, count);
  assert(!JSON.stringify(prepared).includes("sender-"));
});

test("prepared status uses the new operation budget after the preparation signal ends", async () => {
  const { docker } = fakeDocker("sender-one");
  const initial = new AbortController();
  const prepared = await runtimeStatusModule.prepareRuntimeStatus(
    docker,
    project,
    "runtime-id",
    { signal: initial.signal },
  );
  initial.abort();
  assert.equal(
    (await prepared.read(docker, { timeoutMS: 500 })).status,
    "ready",
  );
});

test("a rejected bound status credential cannot trigger new discovery or leak diagnostics", async () => {
  const { docker, calls } = fakeDocker("sender-one");
  const prepared = await runtimeStatusModule.prepareRuntimeStatus(
    docker,
    project,
    "runtime-id",
  );
  const count = calls.length;
  let attempts = 0;
  await assert.rejects(
    prepared.read(async () => {
      attempts++;
      throw new Error("private-sender in failed Docker command");
    }),
    (error) =>
      !error.message.includes("private-sender") && error.cause === undefined,
  );
  assert.equal(attempts, 1);
  assert.equal(calls.length, count);
});

test("prepared status keeps unresolved remote cleanup visible", async () => {
  const { docker } = fakeDocker("sender-one");
  const prepared = await runtimeStatusModule.prepareRuntimeStatus(
    docker,
    project,
    "runtime-id",
  );
  const failure = Object.assign(new Error("remote join missing"), {
    remoteCleanupPending: true,
  });
  await assert.rejects(
    prepared.read(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("Runtime status gives curl a remote deadline within the operation budget", async () => {
  const { docker, calls } = fakeDocker("sender-two");
  await runtimeStatus(docker, project, "runtime-id", { timeoutMS: 500 });
  for (const args of calls.filter((args) => args[1] === "-e")) {
    const bounded = args.at(-1).match(/--max-time ([0-9.]+)/u);
    assert(bounded, "remote curl must not outlive a killed Docker client");
    assert(Number(bounded[1]) > 0 && Number(bounded[1]) <= 0.5);
  }
});

test("Runtime status joins aborted sampling and stops before the next credential", async () => {
  const operation = new AbortController();
  const reason = new Error("outage window expired");
  const { docker: base } = fakeDocker("sender-two");
  let requests = 0;
  let active = 0;
  const docker = async (args, long, options) => {
    if (args[1] !== "-e") return base(args);
    requests++;
    active++;
    try {
      operation.abort(reason);
      await delay(30, undefined, { signal: options?.signal });
      return JSON.stringify({ status: "ready", execution_id: "too-late" });
    } finally {
      active--;
    }
  };
  await assert.rejects(
    runtimeStatus(docker, project, "runtime-id", {
      signal: operation.signal,
      timeoutMS: 500,
    }),
    /outage window expired/u,
  );
  assert.equal(requests, 1);
  assert.equal(active, 0);
});

test("an unjoined Runtime request cannot be hidden by a successful later credential", async () => {
  const { docker: base } = fakeDocker("sender-two");
  const failure = Object.assign(new Error("Runtime attachment lost"), {
    remoteCleanupPending: true,
  });
  let attempts = 0;
  const docker = async (args) => {
    if (args[1] === "-e" && ++attempts === 1) throw failure;
    return base(args);
  };
  await assert.rejects(
    runtimeStatus(docker, project, "runtime-id"),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test("Runtime Controller reads mount the Agent Controller credential", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    return JSON.stringify({ observations: [] });
  };
  const config = { project, credentials: "/fixture/credentials" };
  assert.deepEqual(
    await runtimeControllerRead(
      docker,
      config,
      "/internal/runtime-observations?after_sequence=0&limit=500",
    ),
    { observations: [] },
  );
  const [args] = calls;
  assert.equal(args[0], "run");
  assert(args.includes(`${project}_controller-runtime`));
  assert(
    args.includes(
      "type=bind,src=/fixture/credentials/agent-controller/tokens/runtime-controller,dst=/proof/token,readonly",
    ),
  );
  assert.equal(
    args.at(-1),
    "/internal/runtime-observations?after_sequence=0&limit=500",
  );
  await assert.rejects(
    runtimeControllerRead(docker, config, "http://elsewhere/internal/x"),
  );
});
