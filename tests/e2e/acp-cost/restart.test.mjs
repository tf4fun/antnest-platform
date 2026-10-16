import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";

const url = new URL("./restart.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const entry = (name) => {
  assert.equal(typeof implementation[name], "function", name);
  return implementation[name];
};
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
const expected = {
  project: "antnest-stage3-e2e-1234",
  run_id: "2485d43c-9cb0-42a0-9c9f-186a2dc3e855",
  container_id: "a".repeat(64),
  image_id: "sha256:" + "4".repeat(64),
  image_ref:
    "antnest/agent-acp-service:cost-2485d43c-9cb0-42a0-9c9f-186a2dc3e855",
  started_at: "2026-10-16T10:00:00.000000000Z",
  client_id: "b".repeat(64),
  model_id: "c".repeat(64),
};
const restartedAt = "2026-10-16T10:02:00.000000000Z";
const stop = new Error("original restart cancellation");
function container(role, restarted = false) {
  return {
    Id: role === "acp" ? expected.container_id : expected[role + "_id"],
    Image: expected.image_id,
    Config: {
      Image: expected.image_ref,
      Labels: {
        "com.docker.compose.project": expected.project,
        "com.docker.compose.service":
          role === "acp" ? "agent-acp-service" : "cost-" + role,
        "io.antnest.deployment-admission": expected.project,
        "io.antnest.e2e-run-id": expected.run_id,
      },
    },
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      Dead: false,
      OOMKilled: false,
      ExitCode: 0,
      Error: "",
      Health: { Status: "healthy" },
      StartedAt: restarted ? restartedAt : expected.started_at,
    },
  };
}
async function fixture(t, mode, mutate) {
  const run = entry("restartCostACP");
  const directory = await mkdtemp(join(tmpdir(), "antnest-cost-restart-"));
  const controller = new AbortController();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [],
    responses = [];
  let restarted = false,
    polls = 0,
    waits = 0;
  const primary = new Error("original docker restart failure");
  const wrapperError = new Error("Docker restart interrupted or timed out");
  const docker = async (args, long, options) => {
    assert(options?.signal instanceof AbortSignal);
    assert(options.timeoutMS > 0 && options.timeoutMS <= 2000);
    calls.push({ args, long });
    let raw;
    if (args[0] === "ps") {
      if (mode === "actual Docker ps" && !args.includes("--no-trunc"))
        return expected.container_id.slice(0, 12);
      assert(
        args.includes("label=com.docker.compose.project=" + expected.project),
      );
      assert(
        args.includes("label=com.docker.compose.service=agent-acp-service"),
      );
      return mode === "duplicate ACP"
        ? expected.container_id + "\n" + "d".repeat(64)
        : expected.container_id;
    }
    if (args[0] === "inspect") {
      const role =
        args[1] === expected.container_id
          ? "acp"
          : args[1] === expected.client_id
            ? "client"
            : "model";
      const row = container(role, restarted && role === "acp");
      if (role === "client" && mode === "client exit")
        row.State.Running = false;
      if (role === "acp" && restarted) mutate?.(row);
      if (role === "acp" && restarted && mode === "unhealthy")
        row.State.Health.Status = "unhealthy";
      if (role === "acp" && restarted && mode === "after cancellation")
        controller.abort(stop);
      raw = JSON.stringify([row], null, 3);
    } else if (args[0] === "restart") {
      assert(["--time", "--timeout"].includes(args[1]));
      assert.deepEqual(args, ["restart", args[1], "10", expected.container_id]);
      assert.equal(long, true);
      assert(!restarted, "duplicate actual restart");
      if (mode === "restart failure") throw primary;
      if (mode === "restart in-flight cancellation") {
        controller.abort(stop);
        await turn();
        throw wrapperError;
      }
      restarted = true;
      if (mode === "archive failure after restart") {
        await rm(join(directory, "restart", "events.private.json"));
        await mkdir(join(directory, "restart", "events.private.json"));
      }
      if (mode === "current Docker restart" && args[1] === "--time")
        return (
          "Flag --time has been deprecated, use --timeout instead\n" +
          expected.container_id
        );
      if (mode === "unexpected restart output")
        return "Unexpected Docker diagnostic\n" + expected.container_id;
      return expected.container_id;
    } else if (args[0] === "exec") {
      assert.equal(args[1], expected.model_id);
      const [path, method] = args.slice(-2);
      assert(["/status", "/restarted"].includes(path));
      assert.equal(method, path === "/status" ? "GET" : "POST");
      if (path === "/restarted") assert(restarted);
      const body =
        path === "/status"
          ? {
              checkpoint:
                polls++ === 0
                  ? "running"
                  : mode === "stale ACK"
                    ? "restarted"
                    : "restart",
              requests: [],
              errors: mode === "model error" ? ["fixture failed"] : [],
            }
          : { checkpoint: mode === "wrong ACK" ? "restart" : "restarted" };
      const bodyBytes = Buffer.from(JSON.stringify(body, null, 3) + "\n");
      raw = JSON.stringify({
        status: mode === "model status" ? 503 : 200,
        body_base64: bodyBytes.toString("base64"),
        complete: mode !== "partial model body",
        error_type: mode === "partial model body" ? "TypeError" : null,
      });
      responses.push(bodyBytes);
    } else assert.fail("unexpected Docker operation " + args[0]);
    return raw;
  };
  const options = {
    expected,
    directory,
    docker,
    signal: controller.signal,
    timeout: 2000,
    restartTimeout: 1500,
    wait: async (_ms, _value, { signal }) => {
      waits++;
      if (
        mode === "waiting cancellation" ||
        (mode === "unhealthy" && waits >= 2)
      )
        controller.abort(stop);
      await turn();
      signal.throwIfAborted();
    },
  };
  return {
    directory,
    controller,
    options,
    calls,
    responses,
    primary,
    wrapperError,
    run: () => run(options),
  };
}
async function files(f) {
  return readdir(join(f.directory, "restart"));
}
test("one actual candidate ACP restart precedes the model ACK and retains original inspection/response evidence", async (t) => {
  const f = await fixture(t);
  const receipt = await f.run();
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.actual_restarts, 1);
  assert.equal(receipt.container_id, expected.container_id);
  assert.equal(receipt.image_id, expected.image_id);
  assert.equal(receipt.before_started_at, expected.started_at);
  assert.equal(receipt.after_started_at, restartedAt);
  assert.equal(f.calls.filter((c) => c.args[0] === "restart").length, 1);
  const ack = f.calls.findIndex(
    (c) => c.args[0] === "exec" && c.args.at(-2) === "/restarted",
  );
  const restart = f.calls.findIndex((c) => c.args[0] === "restart");
  assert(ack > restart);
  assert(
    f.calls
      .slice(restart + 1, ack)
      .some(
        (c) => c.args[0] === "inspect" && c.args[1] === expected.container_id,
      ),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(f.directory, "restart", "receipt.json"), "utf8"),
    ),
    receipt,
  );
  const events = JSON.parse(
    await readFile(join(f.directory, "restart", "events.private.json"), "utf8"),
  );
  for (const [index, event] of events.entries()) {
    assert.equal(event.sequence, index + 1);
    if (index) assert(event.monotonic_ms >= events[index - 1].monotonic_ms);
    const raw = await readFile(join(f.directory, "restart", event.file));
    assert.equal(hash(raw), event.sha256);
    assert.equal(raw.length, event.bytes);
  }
  const bodies = await Promise.all(
    events
      .filter((e) => e.kind === "model-response")
      .map((e) => readFile(join(f.directory, "restart", e.file))),
  );
  assert.deepEqual(bodies, f.responses);
  const before = events.find((e) => e.kind === "acp-before");
  assert.equal(
    await readFile(join(f.directory, "restart", before.file), "utf8"),
    JSON.stringify([container("acp")], null, 3) + "\n",
  );
  const priorCalls = f.calls.length;
  await assert.rejects(f.run());
  assert.equal(
    f.calls.length,
    priorCalls,
    "a second invocation may not restart again",
  );
});
test("actual Docker selection requires full IDs rather than default truncated output", async (t) => {
  const f = await fixture(t, "actual Docker ps");
  assert.equal((await f.run()).status, "verified");
});
test("current Docker restart completes without deprecated timeout flag output", async (t) => {
  const f = await fixture(t, "current Docker restart");
  assert.equal((await f.run()).status, "verified");
  assert.deepEqual(f.calls.find((c) => c.args[0] === "restart").args, [
    "restart",
    "--timeout",
    "10",
    expected.container_id,
  ]);
});
test("an in-flight Docker cancellation preserves both the original abort reason and wrapper failure", async (t) => {
  const f = await fixture(t, "restart in-flight cancellation");
  await assert.rejects(f.run(), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [stop, f.wrapperError]);
    return true;
  });
  assert(!f.calls.some((c) => c.args.at(-2) === "/restarted"));
  assert(!(await files(f)).includes("receipt.json"));
});
test("failed evidence recording after an actual restart cannot acknowledge completion", async (t) => {
  const f = await fixture(t, "archive failure after restart");
  await assert.rejects(f.run());
  assert.equal(f.calls.filter((c) => c.args[0] === "restart").length, 1);
  assert(!f.calls.some((c) => c.args.at(-2) === "/restarted"));
  assert(!(await files(f)).includes("receipt.json"));
});
for (const [name, mutate] of [
  [
    "same StartedAt",
    (r) => {
      r.State.StartedAt = expected.started_at;
    },
  ],
  [
    "invalid StartedAt",
    (r) => {
      r.State.StartedAt = "invalid";
    },
  ],
  [
    "different container",
    (r) => {
      r.Id = "d".repeat(64);
    },
  ],
  [
    "different image ID",
    (r) => {
      r.Image = "sha256:" + "5".repeat(64);
    },
  ],
  [
    "different image ref",
    (r) => {
      r.Config.Image = "antnest/agent-acp-service:local";
    },
  ],
  [
    "foreign project",
    (r) => {
      r.Config.Labels["com.docker.compose.project"] = "foreign";
    },
  ],
  [
    "foreign owner",
    (r) => {
      r.Config.Labels["io.antnest.deployment-admission"] = "foreign";
    },
  ],
  [
    "wrong service",
    (r) => {
      r.Config.Labels["com.docker.compose.service"] = "agent-controller";
    },
  ],
  [
    "OOM",
    (r) => {
      r.State.OOMKilled = true;
    },
  ],
  [
    "daemon error",
    (r) => {
      r.State.Error = "daemon error";
    },
  ],
])
  test(`restart refuses ${name} without acknowledging it`, async (t) => {
    const f = await fixture(t, name, mutate);
    await assert.rejects(f.run());
    assert.equal(f.calls.filter((c) => c.args[0] === "restart").length, 1);
    assert(!f.calls.some((c) => c.args.at(-2) === "/restarted"));
    assert(!(await files(f)).includes("receipt.json"));
    assert((await files(f)).includes("failure.private.json"));
  });
for (const mode of [
  "duplicate ACP",
  "client exit",
  "stale ACK",
  "model error",
  "model status",
  "partial model body",
  "waiting cancellation",
  "restart failure",
  "unexpected restart output",
  "unhealthy",
  "after cancellation",
  "wrong ACK",
])
  test(`restart preserves ${mode} and never admits incomplete evidence`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(
      f.run(),
      mode === "restart failure"
        ? (e) => e === f.primary
        : mode.includes("cancellation") || mode === "unhealthy"
          ? (e) => e === stop
          : undefined,
    );
    assert(f.calls.filter((c) => c.args[0] === "restart").length <= 1);
    assert.equal(
      f.calls.filter((c) => c.args.at(-2) === "/restarted").length,
      mode === "wrong ACK" ? 1 : 0,
    );
    assert(!(await files(f)).includes("receipt.json"));
    assert((await files(f)).includes("failure.private.json"));
  });
test("an evidence write failure before the restart cannot trigger a restart or ACK", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "restart"));
  await assert.rejects(f.run());
  assert.deepEqual(f.calls, []);
});
for (const mode of ["complete", "reset", "cancel"])
  test(`model response capture retains exact ${mode} bytes before decoding`, async (t) => {
    const capture = entry("captureCostModelResponse");
    const prefix = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xe2, 0x82]);
    const full = Buffer.from('{ "checkpoint": "restart" }\n');
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const server = createServer(async (_request, response) => {
      response.writeHead(mode === "complete" ? 201 : 200);
      response.write(mode === "complete" ? full : prefix);
      entered.resolve();
      if (mode === "complete") response.end();
      else {
        await release.promise;
        response.destroy();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const controller = new AbortController();
    t.after(async () => {
      controller.abort();
      release.resolve();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const pending = capture(
      `http://127.0.0.1:${server.address().port}/status`,
      "GET",
      {
        signal: controller.signal,
        onChunk: () => {
          if (mode === "cancel") controller.abort(stop);
          release.resolve();
        },
      },
    );
    await entered.promise;
    const result = await pending;
    assert.equal(result.status, mode === "complete" ? 201 : 200);
    assert.equal(result.complete, mode === "complete");
    assert.deepEqual(
      Buffer.from(result.body_base64, "base64"),
      mode === "complete" ? full : prefix,
    );
    assert.equal(result.error_type === null, mode === "complete");
  });
