import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  finishBridgeCase,
  openPausedResponse,
  ownFixtureServer,
  removeBridgeDocker,
  runJoined,
  startBridgePump,
} from "../../support/agent-ui/bridge-container-lifecycle.mjs";

async function bounded(promise, ms = 300) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Lifecycle operation did not settle")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function waitForExit(pid) {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(5);
  }
  throw new Error("Owned child did not exit");
}

test("an already cancelled gate must not start a fixture listener", async () => {
  const abort = new AbortController();
  const reason = new Error("cancel before startup");
  abort.abort(reason);
  const server = createServer();
  const owned = ownFixtureServer(server, abort.signal);
  try {
    await assert.rejects(
      owned.listen(0, "127.0.0.1"),
      (error) => error === reason,
    );
    assert.equal(server.listening, false);
  } finally {
    await owned.close();
  }
});

test("a second listener startup failure rejects and closes the first listener", async () => {
  const first = ownFixtureServer(createServer());
  const second = ownFixtureServer(createServer());
  // Keep the original callback-only implementation's error observable without
  // letting an unhandled server error terminate the regression process.
  second.server.on("error", () => {});
  try {
    await assert.rejects(
      finishBridgeCase({
        body: async () => {
          await first.listen(0, "127.0.0.1");
          await bounded(
            second.listen(first.server.address().port, "127.0.0.1"),
          );
        },
        cleanup: [first.close, second.close],
      }),
      { code: "EADDRINUSE" },
    );
    assert.equal(first.server.listening, false);
    assert.equal(second.server.listening, false);
  } finally {
    await closeServer(first.server);
    await closeServer(second.server);
  }
});

test("business, diagnostic and transport failures retain the original error and still close sockets", async () => {
  const server = createServer();
  await listening(server);
  const business = new Error("business assertion failed");
  const diagnostic = new Error("diagnostic disk failed");
  const transport = new Error("transport close failed");
  try {
    const error = await finishBridgeCase({
      body: async () => {
        throw business;
      },
      diagnostics: async () => {
        throw diagnostic;
      },
      cleanup: [
        async () => {
          throw transport;
        },
        () => closeServer(server),
      ],
    }).then(
      () => undefined,
      (failure) => failure,
    );
    assert.equal(server.listening, false, "all cleanup actions must run");
    assert(error instanceof AggregateError);
    assert.equal(error.cause, business);
    assert.deepEqual(error.errors, [business, diagnostic, transport]);
  } finally {
    await closeServer(server);
  }
});

test("Docker deletion failures stay visible while other owned resources and listeners are cleaned", async () => {
  const containers = new Set(["owned-a", "owned-b"]);
  let imageExists = true;
  const deletion = new Error("Docker refused owned-a deletion");
  const docker = async (args) => {
    if (args[0] === "rm") {
      if (args.at(-1) === "owned-a") throw deletion;
      containers.delete(args.at(-1));
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "rm") {
      imageExists = false;
      return { stdout: "", stderr: "" };
    }
    if (args[1] === "inspect") return { stdout: "owner-1\n", stderr: "" };
    if (args[0] === "container" && args[1] === "ls") {
      const name = args.at(-1).slice("name=^/".length, -1);
      return {
        stdout: containers.has(name) ? "container-id\n" : "",
        stderr: "",
      };
    }
    if (args[0] === "image" && args[1] === "ls")
      return { stdout: imageExists ? "image-id\n" : "", stderr: "" };
    throw new Error("Unexpected Docker cleanup command");
  };
  const server = createServer();
  await listening(server);
  try {
    const error = await finishBridgeCase({
      body: async () => {},
      cleanup: [
        () =>
          removeBridgeDocker(docker, {
            containers: ["owned-a", "owned-b"],
            image: "owned-image:1",
            owner: "owner-1",
          }),
        () => closeServer(server),
      ],
    }).then(
      () => undefined,
      (failure) => failure,
    );
    assert(error, "a failed Docker delete must fail the gate");
    assert(
      error.errors.includes(deletion),
      "preserve the original delete failure",
    );
    assert.equal(containers.has("owned-b"), false);
    assert.equal(imageExists, false);
    assert.equal(server.listening, false);
  } finally {
    await closeServer(server);
  }
});

test(
  "an interrupted command settles only after its real child has closed",
  { timeout: 5000 },
  async () => {
    const evidence = new URL(
      "../../../artifacts/verification/issue-64/agent-ui/",
      import.meta.url,
    );
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(new URL("lifecycle-child-", evidence));
    const ready = join(directory, "ready");
    const stopped = join(directory, "stopped");
    const abort = new AbortController();
    const reason = new Error("stop owned child");
    const child = runJoined(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => setTimeout(() => {
      writeFileSync(process.argv[2], 'stopped'); process.exit(0);
    }, 80));
    writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `,
        ready,
        stopped,
      ],
      { signal: abort.signal, timeout: 2000 },
    );
    void child.catch(() => {});
    let pid;
    try {
      for (let i = 0; i < 200; i++) {
        try {
          pid = Number(await readFile(ready, "utf8"));
          break;
        } catch {
          await delay(5);
        }
      }
      assert.ok(pid, "real child must report readiness before interruption");
      abort.abort(reason);
      const error = await child.then(
        () => undefined,
        (failure) => failure,
      );
      assert.equal(
        await readFile(stopped, "utf8"),
        "stopped",
        "child close must precede rejection",
      );
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(error, reason);
    } finally {
      abort.abort();
      await child.catch(() => {});
      if (pid) {
        for (let i = 0; i < 100; i++) {
          try {
            process.kill(pid, 0);
          } catch {
            pid = undefined;
            break;
          }
          await delay(5);
        }
        if (pid) {
          process.kill(pid, "SIGKILL");
          await waitForExit(pid);
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a command which ignores TERM is killed and joined within its cancellation budget",
  { timeout: 6000 },
  async () => {
    const evidence = new URL(
      "../../../artifacts/verification/issue-64/agent-ui/",
      import.meta.url,
    );
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(new URL("lifecycle-stubborn-", evidence));
    const ready = join(directory, "ready");
    const abort = new AbortController();
    const reason = new Error("stop stubborn child");
    const child = runJoined(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `,
        ready,
      ],
      { signal: abort.signal, timeout: 4000 },
    );
    void child.catch(() => {});
    let pid;
    try {
      for (let i = 0; i < 200; i++) {
        try {
          pid = Number(await readFile(ready, "utf8"));
          break;
        } catch {
          await delay(5);
        }
      }
      assert.ok(pid);
      const started = performance.now();
      abort.abort(reason);
      await assert.rejects(bounded(child, 3500), (error) => error === reason);
      assert.ok(performance.now() - started < 3500);
      await waitForExit(pid);
    } finally {
      abort.abort();
      await child.catch(() => {});
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await waitForExit(pid);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a Docker inventory failure cannot be treated as an absent owned resource", async () => {
  const failure = new Error("Docker inventory unavailable");
  await assert.rejects(
    removeBridgeDocker(
      async () => {
        throw failure;
      },
      {
        containers: ["owned-a"],
        image: "owned-image:1",
        owner: "owner-1",
      },
    ),
    (error) =>
      error instanceof AggregateError && error.errors.includes(failure),
  );
});

test(
  "a parent exiting before its TERM-ignoring descendant cannot end command cleanup",
  { timeout: 8000 },
  async () => {
    const evidence = new URL(
      "../../../artifacts/verification/issue-64/agent-ui/",
      import.meta.url,
    );
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(new URL("lifecycle-descendant-", evidence));
    const parentReady = join(directory, "parent");
    const childReady = join(directory, "child");
    const childSource = `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `;
    const abort = new AbortController();
    const reason = new Error("stop owned process group");
    const command = runJoined(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childSource)}, process.argv[2]], { stdio: 'ignore' });
    writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `,
        parentReady,
        childReady,
      ],
      { signal: abort.signal, timeout: 5000 },
    );
    void command.catch(() => {});
    let parentPid, childPid;
    try {
      for (let i = 0; i < 200; i++) {
        try {
          parentPid = Number(await readFile(parentReady, "utf8"));
          childPid = Number(await readFile(childReady, "utf8"));
          break;
        } catch {
          await delay(5);
        }
      }
      assert.ok(parentPid && childPid);
      abort.abort(reason);
      await assert.rejects(bounded(command, 5000), (error) => {
        assert.equal(
          error,
          reason,
          JSON.stringify(
            error.errors?.map((item) => ({
              name: item.name,
              message: item.message,
              code: item.code,
              syscall: item.syscall,
            })),
          ),
        );
        return true;
      });
      assert.throws(() => process.kill(parentPid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    } finally {
      abort.abort();
      await command.catch(() => {});
      // Keep the regression's own cleanup effective even against the old helper.
      for (const path of [parentReady, childReady]) {
        const pid = Number(await readFile(path, "utf8").catch(() => "0"));
        if (!pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await waitForExit(pid);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("cleanup refuses a resource whose ownership label changed", async () => {
  let deletions = 0;
  const docker = async (args) => {
    if (args.includes("rm")) deletions++;
    return {
      stdout: args.includes("inspect") ? "different-owner\n" : "resource-id\n",
      stderr: "",
    };
  };
  await assert.rejects(
    removeBridgeDocker(docker, {
      containers: ["owned-a"],
      image: "owned-image:1",
      owner: "owner-1",
    }),
    (error) =>
      error.errors.some((item) => item.message.includes("ownership changed")),
  );
  assert.equal(deletions, 0);
});

test("stopping a pump waits for its pending read before releasing the lock", async () => {
  let release,
    unlocked = false,
    stopped = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const reader = {
    read: () => pending,
    cancel: async () => {},
    releaseLock: () => {
      unlocked = true;
    },
  };
  const pump = startBridgePump(
    reader,
    () => false,
    () => assert.fail("normal stop is not a pump failure"),
  );
  const stop = pump.stop().then(() => {
    stopped = true;
  });
  try {
    await delay(20);
    assert.equal(stopped, false);
    assert.equal(unlocked, false);
  } finally {
    release({ done: true });
    await stop;
    await pump.done;
  }
  assert.equal(unlocked, true);
});

test("successful commands and stream watermarks complete without failure callbacks", async () => {
  const result = await runJoined(process.execPath, [
    "-e",
    "process.stdout.write('complete'); process.stderr.write('diagnostic')",
  ]);
  assert.deepEqual(result, { stdout: "complete", stderr: "diagnostic" });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("watermark");
    },
  });
  let failures = 0;
  const pump = startBridgePump(
    stream.getReader(),
    (chunk) => chunk === "watermark",
    () => {
      failures++;
    },
  );
  assert.equal(await pump.done, true);
  await pump.stop();
  assert.equal(stream.locked, false);
  assert.equal(failures, 0);
});

test("cancellation before slow SSE headers closes the actual HTTP request", async () => {
  let requested;
  let closed, socket;
  const seen = new Promise((resolve) => {
    requested = resolve;
  });
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const server = createServer((request) => {
    socket = request.socket;
    socket.once("close", closed);
    requested();
  });
  const base = await listening(server);
  const abort = new AbortController();
  const reason = new Error("stop waiting for SSE headers");
  const pending = openPausedResponse(base, { signal: abort.signal });
  void pending.catch(() => {});
  try {
    await seen;
    abort.abort(reason);
    await assert.rejects(bounded(pending), (error) => error === reason);
    await bounded(disconnected);
    assert.equal(
      socket.destroyed,
      true,
      "the helper must close the real socket before fallback cleanup",
    );
  } finally {
    await closeServer(server);
    const opened = await pending.catch(() => undefined);
    await opened?.close();
  }
});

test("cancellation before the first SSE frame joins and unlocks the reader", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  const base = await listening(server);
  const abort = new AbortController();
  let observedFailure;
  let pump, reader;
  try {
    const response = await fetch(base, { signal: abort.signal });
    reader = response.body.getReader();
    pump = startBridgePump(
      reader,
      () => false,
      (error) => {
        observedFailure = error;
      },
    );
    abort.abort(new Error("cancel before first frame"));
    await assert.rejects(bounded(pump.done));
    await pump.stop().catch(() => {});
    assert(
      observedFailure instanceof Error,
      "pump errors must reach the owning scope immediately",
    );
    assert.equal(response.body.locked, false);
  } finally {
    abort.abort();
    await pump?.stop().catch(() => {});
    reader?.releaseLock();
    await closeServer(server);
  }
});

test("a rejected stream pump aborts an in-flight publisher and joins both operations", async () => {
  let publishing;
  const started = new Promise((resolve) => {
    publishing = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === "/publish") {
      publishing();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("invalid stream frame\n\n");
  });
  const base = await listening(server);
  const abort = new AbortController();
  const failure = new Error("stream decoder failed");
  const publication = fetch(`${base}/publish`, { signal: abort.signal });
  void publication.catch(() => {});
  let pump, reader;
  try {
    await started;
    const response = await fetch(`${base}/events`, { signal: abort.signal });
    reader = response.body.getReader();
    pump = startBridgePump(
      reader,
      () => {
        throw failure;
      },
      (error) => abort.abort(error),
    );
    await assert.rejects(bounded(publication), (error) => error === failure);
    await assert.rejects(pump.done, (error) => error === failure);
    await pump.stop().catch(() => {});
    assert.equal(response.body.locked, false);
  } finally {
    abort.abort();
    await publication.catch(() => {});
    await pump?.stop().catch(() => {});
    reader?.releaseLock();
    await closeServer(server);
  }
});
