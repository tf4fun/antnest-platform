import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import * as implementation from "./gate.mjs";
import { requestProgressRuntimeInspection } from "./runtime-inspection.mjs";

const entry = (name) => {
  assert.equal(typeof implementation[name], "function", name);
  return implementation[name];
};
const run = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
const project = "antnest-stage3-e2e-1234";
const image = `antnest/antnest-runtime:progress-${run}`;
const imageID = "sha256:" + "a".repeat(64);
const agent = "agent_abc123";
const env = {
  COMPOSE_PROJECT_NAME: project,
  ANTNEST_E2E_RUN_ID: run,
  TEST_RUNTIME_IMAGE: image,
};
const row = (agentID = agent, digit = "1") => ({
  Id: digit.repeat(64),
  Image: imageID,
  Config: {
    Image: imageID,
    Labels: {
      "io.antnest.agent-id": agentID,
      "io.antnest.managed": "runtime",
      "io.antnest.runtime-controller-scope": project,
      "io.antnest.runtime-generation": "1",
    },
    Env: [
      `ANTNEST_RUNTIME_IMAGE_REFERENCE=${image}`,
      `ANTNEST_RUNTIME_IMAGE_ID=${imageID}`,
    ],
  },
  State: {
    Running: true,
    Paused: false,
    Restarting: false,
    Dead: false,
    StartedAt: "2026-10-16T00:00:00.123456789Z",
  },
});

async function fixture(t, options = {}) {
  const createHost = entry("createProgressGateHost");
  const base = await mkdtemp(join(tmpdir(), "antnest-progress-gate-"));
  const directory = join(base, "channel"),
    evidence = join(base, "host");
  const controller = new AbortController();
  const signal = AbortSignal.any([t.signal, controller.signal]);
  const calls = [],
    pending = [],
    requests = [];
  let inspectCount = 0,
    current = row(),
    output = "alive 42 12345",
    clock = 0;
  const rows = new Map([[`antnest-runtime-${agent}`, current]]);
  const docker = async (args, long, call) => {
    calls.push({ args, long, call });
    assert.equal(long, false);
    assert(call.signal instanceof AbortSignal);
    assert(call.timeoutMS > 0 && call.timeoutMS <= 10000);
    call.signal.throwIfAborted();
    if (args[0] === "container") {
      current = rows.get(args.at(-1)) ?? current;
      inspectCount++;
      if (options.inspect) await options.inspect(current, inspectCount, call);
      return JSON.stringify([current]);
    }
    assert.equal(args[0], "exec");
    assert.deepEqual(args.slice(1, 5), [
      "--user",
      "1000:1000",
      current.Id,
      "/bin/sh",
    ]);
    assert.equal(args[5], "-c");
    assert.equal(args.length, 7);
    if (options.execute) return options.execute(args[6], call);
    return output;
  };
  const host = createHost({
    env,
    directory,
    evidence,
    imageID,
    docker,
    wait: turn,
  });
  const track = (promise) => {
    pending.push(promise);
    promise.catch(() => {});
    return promise;
  };
  t.after(async () => {
    controller.abort(new Error("gate fixture finished"));
    await Promise.allSettled(pending);
    await rm(base, { recursive: true, force: true });
  });
  const wait = async () => {
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".request.json"))
      .sort();
    const name = files.at(-1);
    if (name && !requests.some((r) => r.name === name))
      requests.push({
        name,
        value: JSON.parse(await readFile(join(directory, name), "utf8")),
      });
    await host.poll(signal);
    await options.wait?.({
      directory,
      requests,
      advance: (ms) => {
        clock += ms;
      },
    });
    await turn();
  };
  return {
    directory,
    evidence,
    calls,
    requests,
    host,
    signal,
    controller,
    track,
    hostOptions: { env, directory, evidence, imageID, docker },
    setRow(value, lookup = value.Config.Labels["io.antnest.agent-id"]) {
      current = value;
      rows.set(`antnest-runtime-${lookup}`, value);
    },
    setOutput(value) {
      output = value;
    },
    advance(ms) {
      clock += ms;
    },
    open: (id = agent, extra = {}) =>
      track(
        implementation.runtimeGate(id, {
          env,
          directory,
          signal,
          wait,
          now: () => clock,
          ...extra,
        }),
      ),
  };
}

test("host-bound IPC uses fixed commands and retains all original request/receipt consumption", async (t) => {
  const f = await fixture(t),
    gate = await f.open();
  assert.equal(
    f.calls.length,
    2,
    "bind inspects before and after without exec",
  );
  await gate.alive("v1-bash-cancel", "bash");
  f.setOutput("pending 42 12345");
  assert.equal(
    await gate.stopped("v1-bash-cancel", "bash", { timeoutMS: 8700 }),
    false,
  );
  f.setOutput("stopped 42 12345");
  assert.equal(
    await gate.stopped("v1-bash-cancel", "bash", { timeoutMS: 6200 }),
    true,
  );
  f.setOutput("released");
  await gate.release("v1-bash-success");
  assert.deepEqual(
    f.requests.map((r) => r.value.sequence),
    [1, 2, 3, 4, 5],
  );
  assert.equal(new Set(f.requests.map((r) => r.value.nonce)).size, 5);
  assert.equal(f.requests[2].value.timeout_ms, 8700);
  assert.equal(f.requests[3].value.timeout_ms, 6200);
  assert.equal((await readdir(f.directory)).length, 15);
  assert.equal((await readdir(f.evidence)).length, 5);
  const raw = JSON.parse(
    await readFile(join(f.evidence, "gate-000003.evidence.json"), "utf8"),
  );
  assert.equal(raw.execution.stdout, "pending 42 12345");
  assert.equal(raw.before[0].State.StartedAt, raw.after[0].State.StartedAt);
  const command = f.calls.find((call) => call.args[0] === "exec").args[6];
  assert(command.includes("/workspace/v1-bash-cancel-pid"));
  assert(command.includes("/proc/"));
});

for (const [label, mutate] of [
  [
    "wrong scope",
    (r) => {
      r.Config.Labels["io.antnest.runtime-controller-scope"] = "other";
    },
  ],
  [
    "wrong Agent",
    (r) => {
      r.Config.Labels["io.antnest.agent-id"] = "agent_other";
    },
  ],
  [
    "not managed",
    (r) => {
      r.Config.Labels["io.antnest.managed"] = "other";
    },
  ],
  [
    "wrong image",
    (r) => {
      r.Image = "sha256:" + "b".repeat(64);
    },
  ],
  [
    "unpinned image",
    (r) => {
      r.Config.Image = image;
    },
  ],
  [
    "duplicate image env",
    (r) => {
      r.Config.Env.push(`ANTNEST_RUNTIME_IMAGE_ID=${imageID}`);
    },
  ],
  [
    "invalid generation",
    (r) => {
      r.Config.Labels["io.antnest.runtime-generation"] = "0";
    },
  ],
  [
    "paused",
    (r) => {
      r.State.Paused = true;
    },
  ],
  [
    "stopped",
    (r) => {
      r.State.Running = false;
    },
  ],
  [
    "missing start",
    (r) => {
      delete r.State.StartedAt;
    },
  ],
])
  test("host refuses bind: " + label, async (t) => {
    const f = await fixture(t),
      value = row();
    mutate(value);
    f.setRow(value, agent);
    await assert.rejects(f.open());
    assert(!f.calls.some((call) => call.args[0] === "exec"));
  });

for (const field of ["generation", "started", "container"])
  test("every probe rejects changed bound Runtime " + field, async (t) => {
    const f = await fixture(t),
      gate = await f.open(),
      value = row();
    if (field === "generation")
      value.Config.Labels["io.antnest.runtime-generation"] = "2";
    if (field === "started")
      value.State.StartedAt = "2026-10-16T00:00:00.123456790Z";
    if (field === "container") value.Id = "2".repeat(64);
    f.setRow(value);
    await assert.rejects(gate.alive("v1-bash-cancel", "bash"));
    assert(!f.calls.some((call) => call.args[0] === "exec"));
  });

test("a restart during exec cannot produce a successful receipt", async (t) => {
  const f = await fixture(t, {
      inspect: (r, count) => {
        if (count === 4) r.State.StartedAt = "2026-10-16T00:00:00.123456790Z";
      },
    }),
    gate = await f.open();
  await assert.rejects(gate.alive("v1-bash-cancel", "bash"));
  const receipt = JSON.parse(
    await readFile(join(f.directory, "gate-000002.receipt.json"), "utf8"),
  );
  assert.equal(receipt.status, "failed");
});

for (const output of [
  "stopped 999 12345",
  "stopped 42 999",
  "1",
  "pending 42 12345\nextra",
  "permission denied",
])
  test(
    "stopped cannot accept unrelated PID identity or malformed Docker output: " +
      output.replaceAll("\n", " "),
    async (t) => {
      const f = await fixture(t),
        gate = await f.open();
      await gate.alive("v1-bash-cancel", "bash");
      f.setOutput(output);
      await assert.rejects(gate.stopped("v1-bash-cancel", "bash"));
    },
  );

test("Docker execution failure remains a failure, never a stopped result", async (t) => {
  const f = await fixture(t, {
      execute: async () => {
        throw new Error("Docker 125 failed");
      },
    }),
    gate = await f.open();
  await assert.rejects(gate.alive("v1-bash-cancel", "bash"));
});
test("a stop probe requires an earlier alive proof for that phase", async (t) => {
  const f = await fixture(t),
    gate = await f.open();
  await assert.rejects(gate.stopped("v1-bash-cancel", "bash"));
  assert(!f.calls.some((call) => call.args[0] === "exec"));
});
test("managed probes bind the original phase and use only fixed marker paths", async (t) => {
  const f = await fixture(t),
    gate = await f.open();
  f.setOutput("alive managed");
  await gate.alive("v2-managed-cancel", "managed");
  f.setOutput("stopped managed");
  assert.equal(await gate.stopped("v2-managed-cancel", "managed"), true);
  assert(
    f.calls.some((call) =>
      call.args.at(-1).includes?.("/workspace/v2-managed-cancel-canceled"),
    ),
  );
});

test("client rejects a success received after its entire IPC budget", async (t) => {
  const f = await fixture(t, {
      wait: ({ requests, advance }) => {
        if (requests.at(-1).value.action === "stopped") advance(9001);
      },
    }),
    gate = await f.open();
  await gate.alive("v1-bash-cancel", "bash");
  f.setOutput("stopped 42 12345");
  await assert.rejects(
    gate.stopped("v1-bash-cancel", "bash", { timeoutMS: 9000 }),
    /deadline/,
  );
});
for (const [label, mutate] of [
  [
    "stale nonce",
    (v) => {
      v.request.nonce = run;
    },
  ],
  [
    "stale sequence",
    (v) => {
      v.request.sequence++;
    },
  ],
  [
    "changed binding",
    (v) => {
      v.runtime.started_at = "2026-10-16T00:00:00.123456790Z";
    },
  ],
  [
    "additional field",
    (v) => {
      v.arbitrary = "command";
    },
  ],
])
  test("client rejects receipt " + label, async (t) => {
    let changed = false;
    const f = await fixture(t, {
        wait: async ({ requests, directory }) => {
          if (requests.at(-1).value.action !== "alive" || changed) return;
          const path = join(directory, "gate-000002.receipt.json");
          const value = JSON.parse(await readFile(path, "utf8"));
          mutate(value);
          await writeFile(path, JSON.stringify(value));
          changed = true;
        },
      }),
      gate = await f.open();
    await assert.rejects(gate.alive("v1-bash-cancel", "bash"));
    assert(!(await readdir(f.directory)).includes("gate-000002.consumed.json"));
  });

test("host rejects client-injected commands before exec", async (t) => {
  const f = await fixture(t),
    gate = await f.open();
  const bad = {
    ...f.requests[0].value,
    sequence: 2,
    nonce: "abcd1234-1234-4234-8234-123456789abc",
    command: "touch /tmp/foreign",
  };
  await writeFile(
    join(f.directory, "gate-000002.request.json"),
    JSON.stringify(bad),
  );
  await assert.rejects(f.host.poll(f.signal));
  assert(!f.calls.some((call) => call.args[0] === "exec"));
  assert(gate);
});

test("final Runtime receipt rechecks the exact four consumed gate bindings including full StartedAt", async (t) => {
  const f = await fixture(t),
    agents = [];
  for (let i = 1; i <= 4; i++) {
    const id = `agent_a${i}`;
    agents.push(id);
    f.setRow(row(id, String(i)));
    await f.open(id);
  }
  await assert.rejects(f.host.finish(agents.slice(0, 3), f.signal));
  const result = await f.host.finish(agents, f.signal);
  assert.deepEqual(
    result.runtimes.map((r) => r.agent_id),
    agents,
  );
  assert(result.runtimes.every((r) => r.started_at === row().State.StartedAt));
  assert.match(result.raw_sha256, /^[a-f0-9]{64}$/u);
});

test("host interruption joins the in-flight command and preserves failed partial evidence", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await fixture(t, {
      execute: async (_script, call) => {
        entered.resolve();
        await release.promise;
        call.signal.throwIfAborted();
        return "alive 42 12345";
      },
    }),
    gate = await f.open();
  let settled = false;
  const pending = f.track(gate.alive("v1-bash-cancel", "bash"));
  pending
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  try {
    await entered.promise;
    f.controller.abort(new Error("host interrupted"));
    await turn();
    assert.equal(settled, false);
  } finally {
    release.resolve();
  }
  await assert.rejects(pending);
  const receipt = JSON.parse(
    await readFile(join(f.directory, "gate-000002.receipt.json"), "utf8"),
  );
  assert.equal(receipt.status, "failed");
  const raw = JSON.parse(
    await readFile(join(f.evidence, "gate-000002.evidence.json"), "utf8"),
  );
  assert(raw.before && raw.error);
});

for (const target of ["request", "receipt", "evidence"])
  test("final ACK rejects tampered original gate " + target, async (t) => {
    const f = await fixture(t),
      agents = [];
    for (let i = 1; i <= 4; i++) {
      const id = `agent_a${i}`;
      agents.push(id);
      f.setRow(row(id, String(i)));
      await f.open(id);
    }
    const path = join(
      target === "evidence" ? f.evidence : f.directory,
      `gate-000001.${target}.json`,
    );
    await writeFile(path, (await readFile(path, "utf8")) + " ");
    await assert.rejects(
      f.host.finish(agents, f.signal),
      /original|evidence|hash|receipt|request/,
    );
  });

test("a request arriving during final inspection prevents final ACK", async (t) => {
  let directory;
  const f = await fixture(t, {
      inspect: async (_r, count) => {
        if (count === 9)
          await writeFile(join(directory, "gate-000005.request.json"), "{}");
      },
    }),
    agents = [];
  directory = f.directory;
  for (let i = 1; i <= 4; i++) {
    const id = `agent_a${i}`;
    agents.push(id);
    f.setRow(row(id, String(i)));
    await f.open(id);
  }
  await assert.rejects(f.host.finish(agents, f.signal), /unsettled|request/);
  assert(!(await readdir(f.evidence)).includes("gate-final.evidence.json"));
});

test("a same-container restart at final ACK is rejected with raw failure evidence", async (t) => {
  const f = await fixture(t),
    agents = [];
  for (let i = 1; i <= 4; i++) {
    const id = `agent_a${i}`;
    agents.push(id);
    f.setRow(row(id, String(i)));
    await f.open(id);
  }
  const restarted = row(agents[2], "3");
  restarted.State.StartedAt = "2026-10-16T00:00:00.123456790Z";
  f.setRow(restarted);
  await assert.rejects(f.host.finish(agents, f.signal), /bound Runtime/);
  const raw = JSON.parse(
    await readFile(join(f.evidence, "gate-final-failed.evidence.json"), "utf8"),
  );
  assert.equal(raw.rows.length, 3);
  assert(raw.error);
});

test("raw Docker evidence may not be placed inside the client channel", async (t) => {
  const create = entry("createProgressGateHost"),
    f = await fixture(t);
  assert.throws(
    () =>
      create({
        env,
        imageID,
        directory: f.directory,
        evidence: join(f.directory, "private"),
        docker: () => assert.fail("Docker unexpectedly invoked"),
      }),
    /exposed|separate|channel/,
  );
});

test("a rejected original inspect still preserves its exact raw Docker response", async (t) => {
  const f = await fixture(t),
    value = row();
  value.Config.Labels["io.antnest.runtime-controller-scope"] = "foreign";
  f.setRow(value);
  await assert.rejects(f.open());
  const raw = JSON.parse(
    await readFile(join(f.evidence, "gate-000001.evidence.json"), "utf8"),
  );
  assert.equal(raw.before_raw, JSON.stringify([value]));
});
for (const reason of [undefined, null])
  test(
    "a non-Error rejection after exec cannot produce a verified receipt: " +
      String(reason),
    async (t) => {
      const f = await fixture(t, {
          inspect: (_r, count) => {
            if (count === 4) throw reason;
          },
        }),
        gate = await f.open();
      await assert.rejects(gate.alive("v1-bash-cancel", "bash"));
      const receipt = JSON.parse(
        await readFile(join(f.directory, "gate-000002.receipt.json"), "utf8"),
      );
      assert.equal(receipt.status, "failed");
    },
  );

test("one joined host loop services gates before the final four-Runtime inspection", async (t) => {
  const serve = entry("serveProgressGates"),
    f = await fixture(t);
  const checkpointDirectory = join(f.evidence, "checkpoint"),
    agents = [];
  const host = f.track(
    serve({
      ...f.hostOptions,
      checkpointDirectory,
      signal: f.signal,
      wait: turn,
    }),
  );
  for (let i = 1; i <= 4; i++) {
    const id = `agent_a${i}`;
    agents.push(id);
    f.setRow(row(id, String(i)));
    await f.open(id, { wait: turn });
  }
  const client = f.track(
    requestProgressRuntimeInspection(agents, {
      env,
      directory: checkpointDirectory,
      signal: f.signal,
      wait: turn,
    }),
  );
  const [receipt, result] = await Promise.all([client, host]);
  assert.deepEqual(receipt, result);
  assert.deepEqual(
    receipt.runtimes.map((r) => r.agent_id),
    agents,
  );
  assert(receipt.runtimes.every((r) => r.started_at === row().State.StartedAt));
});
