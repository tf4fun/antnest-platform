import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

const container = "a".repeat(64);
const load = () => import("./resolve-cache-runtime-exec.mjs");
const args = (command) => [
  "exec",
  "--user",
  "1000:1000",
  container,
  "sh",
  "-c",
  command,
];
function localRemote(onChild = () => {}) {
  return (command, invocation, options) => {
    assert.equal(command, "docker");
    assert.deepEqual(invocation.slice(0, 5), [
      "exec",
      "-i",
      "--user",
      "1000:1000",
      container,
    ]);
    assert.equal(invocation[5], "node");
    const child = spawn(process.execPath, invocation.slice(6), options);
    onChild(child);
    return child;
  };
}

test("Runtime exec returns complete output only after its remote shell and Node exit", async () => {
  const { joinedRuntimeExec } = await load();
  let child;
  const result = await joinedRuntimeExec({
    args: args("printf 'actual output'"),
    spawnProcess: localRemote((value) => (child = value)),
    timeoutMS: 5000,
  });
  assert.equal(result, "actual output");
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test(
  "Runtime exec cancellation closes a pending HTTP body and joins the remote process",
  { timeout: 15000 },
  async () => {
    const { joinedRuntimeExec } = await load();
    let received;
    const requested = new Promise((resolve) => (received = resolve));
    let socketClosed;
    const closed = new Promise((resolve) => (socketClosed = resolve));
    const server = createServer((request, response) => {
      request.socket.once("close", socketClosed);
      response.writeHead(200);
      response.write('{"status":');
      received();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const abort = new AbortController();
    let child;
    const run = joinedRuntimeExec({
      args: args(
        `curl --silent --max-time 10 http://127.0.0.1:${server.address().port}/status`,
      ),
      signal: abort.signal,
      spawnProcess: localRemote((value) => (child = value)),
      timeoutMS: 5000,
    });
    const rejected = assert.rejects(run, (error) => {
      assert.match(error.message, /interrupted|timed out/u);
      assert.equal(error.remoteCleanupPending, false);
      return true;
    });
    try {
      await requested;
      abort.abort();
      await rejected;
      await closed;
      assert.equal(child.exitCode, 1);
      assert.equal(
        child.signalCode,
        null,
        "killing the CLI alone does not join the remote exec",
      );
    } finally {
      abort.abort();
      await run.catch(() => {});
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test("cancellation before remote ready never executes the emit command", async () => {
  const { joinedRuntimeExec } = await load();
  const directory = mkdtempSync(join(tmpdir(), "runtime-exec-"));
  const marker = join(directory, "emit");
  const abort = new AbortController();
  let child;
  try {
    await assert.rejects(
      joinedRuntimeExec({
        args: args(`: > '${marker}'`),
        signal: abort.signal,
        spawnProcess: localRemote((value) => {
          child = value;
          value.once("spawn", () => abort.abort());
        }),
        timeoutMS: 5000,
      }),
      /interrupted/u,
    );
    assert.equal(existsSync(marker), false);
    assert.equal(child.exitCode, 1);
    assert.equal(child.signalCode, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uncooperative remote exec requires outer cleanup after killing and joining the local client", async () => {
  const { joinedRuntimeExec } = await load();
  const abort = new AbortController();
  let child;
  await assert.rejects(
    joinedRuntimeExec({
      args: args("true"),
      signal: abort.signal,
      spawnProcess: (_command, _invocation, options) => {
        child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          options,
        );
        child.once("spawn", () => abort.abort());
        return child;
      },
      timeoutMS: 5000,
    }),
    (error) => {
      assert.equal(error.remoteCleanupPending, true);
      assert.match(error.message, /interrupted/u);
      return true;
    },
  );
  assert.equal(child.signalCode, "SIGKILL");
});

test("an attachment exit without a remote join receipt cannot certify remote cleanup", async () => {
  const { joinedRuntimeExec } = await load();
  await assert.rejects(
    joinedRuntimeExec({
      args: args("true"),
      spawnProcess: (_command, _invocation, options) =>
        spawn(process.execPath, ["-e", "process.exitCode = 1"], options),
      timeoutMS: 5000,
    }),
    (error) => {
      assert.equal(error.remoteCleanupPending, true);
      return true;
    },
  );
});

test("a failed sampling shell retains its bounded private cause after joining", async () => {
  const { joinedRuntimeExec } = await load();
  await assert.rejects(
    joinedRuntimeExec({
      args: args("printf 'sampling-shell-canary\\n' >&2; exit 7"),
      spawnProcess: localRemote(),
      timeoutMS: 5000,
    }),
    (error) => {
      assert.equal(error.remoteCleanupPending, false);
      assert.equal(error.runtimeExec.ready, true);
      assert.equal(error.runtimeExec.result_seen, false);
      assert.equal(error.runtimeExec.joined, true);
      assert.equal(error.runtimeExec.forced, false);
      assert.equal(error.runtimeExec.exit_code, 1);
      assert.equal(error.runtimeExec.signal, null);
      assert.equal(
        error.runtimeExec.remote.message,
        "Runtime sampling command failed",
      );
      assert.equal(error.runtimeExec.remote.shell.exit_code, 7);
      assert.equal(error.runtimeExec.remote.shell.signal, null);
      assert.equal(
        error.runtimeExec.remote.shell.stderr,
        "sampling-shell-canary\n",
      );
      assert.equal(error.runtimeExec.remote.shell.stderr_truncated, false);
      assert.equal(Object.keys(error).includes("runtimeExec"), false);
      assert.equal(
        inspect(new AggregateError([error])).includes("sampling-shell-canary"),
        false,
      );
      return true;
    },
  );
});

test("pre-handshake attachment failure retains stderr without credentials or false join", async () => {
  const { joinedRuntimeExec } = await load();
  const secret = "fixture-credential-canary";
  const invocation = args("true");
  invocation.splice(1, 0, "-e", `PRIVATE_TOKEN=${secret}`);
  await assert.rejects(
    joinedRuntimeExec({
      args: invocation,
      spawnProcess: (_command, _invocation, options) =>
        spawn(
          process.execPath,
          [
            "-e",
            `process.stderr.write("attachment-canary ${secret}\\n"); process.exitCode=1;`,
          ],
          options,
        ),
      timeoutMS: 5000,
    }),
    (error) => {
      assert.equal(error.remoteCleanupPending, true);
      assert.equal(error.runtimeExec.ready, false);
      assert.equal(error.runtimeExec.result_seen, false);
      assert.equal(error.runtimeExec.joined, null);
      assert.equal(error.runtimeExec.exit_code, 1);
      assert.equal(error.runtimeExec.remote, null);
      assert.equal(error.runtimeExec.stderr, "attachment-canary [redacted]\n");
      assert.equal(JSON.stringify(error.runtimeExec).includes(secret), false);
      return true;
    },
  );
});

test("sampling diagnostics have a fixed byte bound and retain truncation and exit cause", async () => {
  const { joinedRuntimeExec } = await load();
  await assert.rejects(
    joinedRuntimeExec({
      args: args(
        "awk 'BEGIN { for (i=0; i<12000; i++) printf \"x\" }' >&2; exit 9",
      ),
      spawnProcess: localRemote(),
      timeoutMS: 5000,
    }),
    (error) => {
      assert.equal(error.remoteCleanupPending, false);
      const shell = error.runtimeExec.remote.shell;
      assert.equal(shell.exit_code, 9);
      assert.equal(shell.stderr_bytes, 12000);
      assert.equal(Buffer.byteLength(shell.stderr), 8192);
      assert.equal(shell.stderr_truncated, true);
      return true;
    },
  );
});

test("attachment diagnostics redact credentials across chunks and at the byte limit", async () => {
  const { joinedRuntimeExec } = await load();
  const secret = "fixture-long-credential-canary";
  const invocation = args("true");
  invocation.splice(1, 0, "-e", `PRIVATE_TOKEN=${secret}`);
  for (const prefixLength of [0, 8180, 8187])
    await assert.rejects(
      joinedRuntimeExec({
        args: invocation,
        spawnProcess: (_command, _invocation, options) =>
          spawn(
            process.execPath,
            [
              "-e",
              `
            process.stdin.resume();
            process.stderr.write(${JSON.stringify("x".repeat(prefixLength))} + ${JSON.stringify(secret.slice(0, 12))});
            setTimeout(() => {
              process.stderr.write(${JSON.stringify(secret.slice(12))});
              process.stdin.destroy();
              process.exitCode = 1;
            }, 20);
          `,
            ],
            options,
          ),
        timeoutMS: 5000,
      }),
      (error) => {
        assert.equal(
          error.runtimeExec.stderr,
          ("x".repeat(prefixLength) + "[redacted]").slice(0, 8192),
        );
        assert(Buffer.byteLength(error.runtimeExec.stderr) <= 8192);
        assert.equal(error.runtimeExec.stderr_truncated, prefixLength > 0);
        assert.equal(error.runtimeExec.forced, false);
        return true;
      },
    );
});

test("attachment stderr remains byte bounded when truncation splits a UTF-8 character", async () => {
  const { joinedRuntimeExec } = await load();
  await assert.rejects(
    joinedRuntimeExec({
      args: args("true"),
      spawnProcess: (_command, _invocation, options) =>
        spawn(
          process.execPath,
          [
            "-e",
            "process.stderr.write('x'.repeat(8191) + '€tail'); process.exitCode = 1;",
          ],
          options,
        ),
      timeoutMS: 5000,
    }),
    (error) => {
      assert(error.runtimeExec.stderr_truncated);
      assert(Buffer.byteLength(error.runtimeExec.stderr) <= 8192);
      assert.equal(error.runtimeExec.stderr_bytes, 8198);
      return true;
    },
  );
});

test("remote shell startup diagnostics retain the original error code without invocation", async () => {
  const { joinedRuntimeExec } = await load();
  await assert.rejects(
    joinedRuntimeExec({
      args: args("true"),
      environment: {
        ...process.env,
        PATH: "/nonexistent-runtime-diagnostic-path",
      },
      spawnProcess: localRemote(),
      timeoutMS: 5000,
    }),
    (error) => {
      assert.equal(error.runtimeExec.remote.code, "ENOENT");
      assert.equal(
        error.runtimeExec.remote.message,
        "Runtime sampling could not start",
      );
      assert.equal(error.remoteCleanupPending, false);
      return true;
    },
  );
});

test("a sampling shell cannot report success while its detached-stdio descendant is alive", async () => {
  const { joinedRuntimeExec } = await load();
  const directory = mkdtempSync(join(tmpdir(), "runtime-descendant-"));
  const receipt = join(directory, "pid");
  let pid;
  let run;
  try {
    run = joinedRuntimeExec({
      args: args(
        `sleep 5 >/dev/null 2>&1 & child=$!; printf '%s' "$child" > '${receipt}'`,
      ),
      spawnProcess: localRemote(),
      timeoutMS: 5000,
    });
    await assert.rejects(run, (error) => {
      assert.equal(error.remoteCleanupPending, false);
      return true;
    });
    pid = Number(readFileSync(receipt, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (!pid && existsSync(receipt))
      pid = Number(readFileSync(receipt, "utf8"));
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    await run?.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a result receipt does not release ownership before remote exit", async () => {
  const { joinedRuntimeExec } = await load();
  let child;
  let resultReceived;
  const received = new Promise((resolve) => (resultReceived = resolve));
  let done = false;
  const run = joinedRuntimeExec({
    args: args("true"),
    spawnProcess: (_command, _invocation, options) => {
      child = spawn(
        process.execPath,
        [
          "-e",
          `
        process.stdout.write(JSON.stringify({kind:"ready"})+"\\n");
        process.stdin.once("data", () => {
          process.stdout.write(JSON.stringify({kind:"result",output:"complete"})+"\\n");
          process.stdout.write(JSON.stringify({kind:"joined",joined:true})+"\\n");
          setTimeout(() => { process.stdin.destroy(); }, 100);
        });
      `,
        ],
        options,
      );
      child.stdout.on("data", (data) => {
        if (data.toString().includes('"kind":"result"')) resultReceived();
      });
      return child;
    },
    timeoutMS: 5000,
  });
  run.then(
    () => (done = true),
    () => (done = true),
  );
  await received;
  assert.equal(done, false);
  assert.equal(child.exitCode, null);
  assert.equal(await run, "complete");
  assert.equal(child.exitCode, 0);
});
