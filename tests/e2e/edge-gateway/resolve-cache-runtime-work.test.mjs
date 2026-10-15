import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
      /sampling window expired|aborted/u,
    );
    assert.equal(active, 0);
    assert.equal(calls.length, countAtAbort);
    assert.equal(work.evidence.observations.length, observations);
    if (stage === "emit") assert.equal(work.evidence.emit.at, undefined);
  });

test("one Runtime observation shares a deadline across its sequential commands", async () => {
  const { work, calls, intercept } = await fixture();
  const before = calls.length;
  const budgets = [];
  intercept(async (args, options) => {
    budgets.push(options?.timeoutMS);
    await delay(30, undefined, { signal: options?.signal });
  });
  await assert.rejects(work.observe({ timeoutMS: 65 }), /timed out|aborted/u);
  assert(calls.length - before < 5, "sampling continued past its deadline");
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
