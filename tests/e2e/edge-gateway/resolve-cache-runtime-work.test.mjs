import assert from "node:assert/strict";
import test from "node:test";
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from "node:timers/promises";
import * as runtimeWorkModule from "./resolve-cache-runtime-work.mjs";

async function fixture({ readerOrganization = "org-1" } = {}) {
  const calls = [];
  const joinedCalls = [];
  let intercept;
  const id = "a".repeat(64);
  const agent = {
    agent_id: "agent-1",
    owner_user_id: "user-1",
    executable_execution_revision: "execution-1",
    runtime: { runtime_revision: "revision-1" },
  };
  const config = {
    project: "antnest-lifecycle-1234abcd",
    resolvedImage: `sha256:${"b".repeat(64)}`,
  };
  const mounts = [
    ["/workspace", "antnest-workspace-agent-1", true],
    ["/skills", "skills-volume", false],
    ["/run/antnest-auth", "receiver-volume", false],
    [
      "/etc/resolv.conf",
      "antnest-runtime-resolver-1234567890abcdef1234567890abcdef",
      false,
    ],
  ].map(([Destination, Name, RW]) => ({
    Type: "volume",
    Destination,
    Name,
    RW,
  }));
  const raw = [
    "pid:42",
    "effects:" + Buffer.from("started\n").toString("base64"),
    "stat:" + Buffer.from("42 (bash) S 30 30 0 0").toString("base64"),
    "processes:" + Buffer.from("42 (bash) S 30 30 0 0").toString("base64"),
  ].join("\n");
  const docker = async (args, long, options) => {
    calls.push(args);
    await intercept?.(args, options);
    if (args[0] === "ps") return id;
    if (args[0] === "volume") return mounts.map((row) => row.Name).join("\n");
    if (args[0] === "compose") return "controller";
    if (args[0] === "inspect")
      return JSON.stringify([
        args[1] === "controller"
          ? { Id: "controller" }
          : {
              Id: id,
              Image: config.resolvedImage,
              Mounts: mounts,
              Config: {
                Labels: {
                  "io.antnest.agent-id": agent.agent_id,
                  "io.antnest.runtime-generation": "1",
                  "io.antnest.runtime-spec-digest": "digest-1",
                },
              },
              RestartCount: 0,
              State: {
                StartedAt: "2026-10-14T00:00:00Z",
                Running: true,
                Health: { Status: "healthy" },
              },
            },
      ]);
    if (args[0] === "exec" && args[1] === "controller") return "fixture-sender";
    if (args[0] === "exec" && args[1] === "-e")
      return JSON.stringify({ status: "ready", execution_id: "runtime-1" });
    if (args[0] === "exec" && args[1] === "--user")
      return args.at(-1).includes("runtime_work_pid=") ? raw : "";
    assert.fail("unexpected fixture Docker command");
  };
  const work = await runtimeWorkModule.createCacheRuntimeWork({
    docker,
    config,
    agent,
    principal: { organization_id: "org-1", user_id: "user-1" },
    readerPrincipal: {
      organization_id: readerOrganization,
      user_id: "admin-1",
    },
    execRuntime: async ({ args, signal, timeoutMS }) => {
      joinedCalls.push(args);
      return docker(args, false, { signal, timeoutMS });
    },
  });
  work.evidence.started = await work.observe();
  return { work, calls, joinedCalls, intercept: (fn) => (intercept = fn) };
}

test("Runtime binding accepts the actual admin Agent DTO without organization_id", async () => {
  const { work } = await fixture();
  assert.equal(work.evidence.container.agent_id, "agent-1");
});

test("Runtime binding rejects an Agent read through a different organization principal", async () => {
  await assert.rejects(fixture({ readerOrganization: "other-org" }));
});

test("each held-work sample reads live Runtime state without rediscovering Controller credentials", async () => {
  const { work, calls, joinedCalls } = await fixture();
  const before = calls.length;
  const joined = joinedCalls.length;
  await work.observe();
  const observation = calls.slice(before);
  assert.equal(
    observation.some(
      (args) => args[0] === "compose" || args[1] === "controller",
    ),
    false,
  );
  assert(
    observation.some(
      (args) => args[0] === "inspect" && args[1] === work.evidence.container.id,
    ),
  );
  assert.deepEqual(
    joinedCalls.slice(joined).map((args) => args[1]),
    ["-e", "--user"],
  );
});

test("all Runtime status, process, freshness and emit commands use cooperative remote exec", async () => {
  const { work, calls, joinedCalls } = await fixture();
  await work.assertFresh();
  await work.emit();
  const runtimeCalls = calls.filter(
    (args) => args[0] === "exec" && args.includes(work.evidence.container.id),
  );
  assert(runtimeCalls.length >= 5);
  assert.deepEqual(joinedCalls, runtimeCalls);
});

const samplingStage = (args) =>
  args[0] === "ps"
    ? "physical"
    : args[0] === "exec" && args[1] === "-e"
      ? "status"
      : args[0] === "exec" && args[1] === "--user"
        ? "process"
        : undefined;

test("a slow independent physical query does not postpone live status or process sampling", async () => {
  const { work, intercept } = await fixture();
  const release = Promise.withResolvers();
  const started = [];
  intercept(async (args) => {
    const stage = samplingStage(args);
    if (!stage) return;
    started.push(stage);
    await release.promise;
  });
  const count = work.evidence.observations.length;
  const result = work.observe();
  try {
    await nextTurn();
    assert.deepEqual(started, ["physical", "status", "process"]);
    assert.equal(work.evidence.observations.length, count);
  } finally {
    release.resolve();
    await result;
  }
  const sample = await result;
  assert.deepEqual(sample.container, work.evidence.container);
  assert.equal(sample.status.execution_id, work.evidence.runtime_execution_id);
  assert.equal(sample.work.pgid, work.evidence.started.work.pgid);
  assert.equal(work.evidence.observations.length, count + 1);
});

test("a physical query failure joins both live readers before exposing its original error", async () => {
  const { work, intercept } = await fixture();
  const release = Promise.withResolvers();
  const failure = new Error("original Runtime discovery failed");
  const joined = [];
  let settled = false;
  intercept(async (args) => {
    const stage = samplingStage(args);
    if (stage === "physical") throw failure;
    if (stage) {
      await release.promise;
      joined.push(stage);
    }
  });
  const count = work.evidence.observations.length;
  const result = work.observe().then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await nextTurn();
    assert.equal(settled, false);
  } finally {
    release.resolve();
    await result;
  }
  assert.equal(await result, failure);
  assert.deepEqual(joined.sort(), ["process", "status"]);
  assert.equal(work.evidence.observations.length, count);
});

test("independent sampling failures preserve every cause after the final reader joins", async () => {
  const { work, intercept } = await fixture();
  const release = Promise.withResolvers();
  const physical = new Error("Runtime replaced");
  const process = new Error("remote process cleanup pending");
  process.remoteCleanupPending = true;
  let statusJoined = false;
  intercept(async (args) => {
    const stage = samplingStage(args);
    if (stage === "physical") throw physical;
    if (stage === "process") throw process;
    if (stage === "status") {
      await release.promise;
      statusJoined = true;
    }
  });
  const count = work.evidence.observations.length;
  const result = work.observe().then(
    () => undefined,
    (error) => error,
  );
  try {
    await nextTurn();
  } finally {
    release.resolve();
    await result;
  }
  const error = await result;
  assert(error instanceof AggregateError);
  assert.deepEqual(error.errors, [physical, process]);
  assert.equal(statusJoined, true);
  assert.equal(work.evidence.observations.length, count);
});

for (const failedStage of ["status", "process"])
  test(`a ${failedStage} exec failure preserves its private receipt before status wrapping and waits for other readers`, async () => {
    const { work, intercept } = await fixture();
    const release = Promise.withResolvers();
    const failure = new Error("Runtime exec reported failure");
    failure.remoteCleanupPending = false;
    Object.defineProperty(failure, "runtimeExec", {
      value: { ready: true, joined: true, remote: { code: "EACCES" } },
    });
    let settled = false;
    intercept(async (args) => {
      const stage = samplingStage(args);
      if (stage === failedStage) throw failure;
      if (stage) await release.promise;
    });
    const count = work.evidence.observations.length;
    const pending = work.observe().catch((error) => {
      settled = true;
      return error;
    });
    try {
      await nextTurn();
      assert.equal(settled, false);
    } finally {
      release.resolve();
      await pending;
    }
    const error = await pending;
    assert(error instanceof Error);
    assert.equal(work.evidence.observations.length, count);
    assert.deepEqual(work.evidence.exec_failures, [
      {
        stage: failedStage,
        name: failure.name,
        message: failure.message,
        remote_cleanup_pending: false,
        receipt: failure.runtimeExec,
      },
    ]);
  });

const samplingFailure = (error) =>
  error instanceof AggregateError
    ? error.errors.some(samplingFailure)
    : /sampling window expired|timed out|aborted/u.test(error.message);

test("repeated exec failures keep the first bounded private receipts and count omitted failures", async () => {
  const { work, intercept } = await fixture();
  const failure = new Error("Runtime exec reported failure");
  intercept(async (args) => {
    if (samplingStage(args) === "process") throw failure;
  });
  for (let index = 0; index < 18; index++)
    await assert.rejects(work.observe(), (error) => error === failure);
  assert.equal(work.evidence.exec_failures.length, 16);
  assert.equal(work.evidence.exec_failures_dropped, 2);
  assert(work.evidence.exec_failures.every((row) => row.stage === "process"));
});

for (const stage of ["physical", "status", "process", "emit"])
  test(`held Runtime ${stage} observation joins interrupted work and stops issuing commands`, async () => {
    const { work, calls, intercept } = await fixture();
    const abort = new AbortController();
    const reason = new Error("sampling window expired");
    let active = 0;
    let countAtAbort;
    intercept(async (args, options) => {
      const target =
        stage === "physical"
          ? args[0] === "ps"
          : stage === "status"
            ? args[1] === "-e"
            : args[1] === "--user";
      if (!target) return;
      countAtAbort = calls.length;
      active++;
      try {
        abort.abort(reason);
        await delay(30, undefined, { signal: options?.signal });
      } finally {
        active--;
      }
    });
    const observations = work.evidence.observations.length;
    await assert.rejects(
      stage === "emit"
        ? work.emit({ signal: abort.signal, timeoutMS: 500 })
        : work.observe({ signal: abort.signal, timeoutMS: 500 }),
      samplingFailure,
    );
    assert.equal(active, 0);
    assert.equal(calls.length, countAtAbort);
    assert.equal(work.evidence.observations.length, observations);
    if (stage === "emit") assert.equal(work.evidence.emit.at, undefined);
  });

test("one Runtime observation shares a deadline across discovery and independent live readers", async () => {
  const { work, calls, intercept } = await fixture();
  const count = work.evidence.observations.length;
  const budgets = [];
  intercept(async (args, options) => {
    budgets.push(options?.timeoutMS);
    await delay(30, undefined, { signal: options?.signal });
  });
  await assert.rejects(work.observe({ timeoutMS: 65 }), samplingFailure);
  const completedCalls = calls.length;
  await nextTurn();
  assert.equal(calls.length, completedCalls, "sampling continued after join");
  assert.equal(work.evidence.observations.length, count);
  assert(budgets.length >= 2);
  assert(budgets.every((budget) => budget > 0 && budget <= 65));
  assert(budgets.at(-1) < budgets[0]);
});

test("outage polling awaits an interrupted check and rejects its late truthy result", async () => {
  const abort = new AbortController();
  const reason = new Error("window ended during check");
  let active = 0;
  let checks = 0;
  await assert.rejects(
    runtimeWorkModule.pollOutageObservation(
      async (signal) => {
        assert(signal instanceof AbortSignal);
        checks++;
        active++;
        try {
          abort.abort(reason);
          await delay(30);
          return { tooLate: true };
        } finally {
          active--;
        }
      },
      "Runtime sampling",
      abort.signal,
      500,
    ),
    /window ended during check/u,
  );
  assert.equal(checks, 1);
  assert.equal(active, 0);
});
