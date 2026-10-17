import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  composeArgs,
  dockerClient,
  owned,
  scopeLabel,
  networkOctet,
  cleanup,
  stderrDiagnostic,
} from "./docker.mjs";

test("Docker failure diagnostics keep the stderr tail and redact secrets", () => {
  const env = {
    ANTNEST_SERVICE_TOKEN: "changeme-token-xxxxxxxx",
    ANTNEST_TEMPORAL_POSTGRES_PASSWORD: "changeme-xxxxxxxx",
    ANTNEST_SHORT_KEY: "abc",
    ANTNEST_EDGE_HOST_PORT: "18080",
  };
  const text = [
    ...Array.from({ length: 30 }, (_, i) => `line ${i}`),
    "container antnest-x-postgres-1 is unhealthy",
    "env changeme-token-xxxxxxxx and changeme-xxxxxxxx on 18080",
    "Authorization: Bearer abc.def-ghi",
    "",
  ].join("\n");
  const result = stderrDiagnostic(text, env);
  assert.equal(result.split("\n").length, 12);
  assert.match(result, /^line 21\n/);
  assert.match(result, /antnest-x-postgres-1 is unhealthy/);
  assert.match(result, /env \[redacted\] and \[redacted\] on 18080/);
  assert.match(result, /Bearer \[redacted\]/);
  assert.doesNotMatch(result, /changeme|abc\.def/);
  assert.equal(stderrDiagnostic(" \n", env), "");
  assert(stderrDiagnostic("x".repeat(10000), env).length <= 2000);
});

for (const kind of ["container", "volume", "network"])
  test(`cleanup preserves conflicted ${kind} and continues with later owned resources`, async () => {
    const project = "antnest-lifecycle-1234abcd";
    const remaining = new Map(
      ["foreign", "own"].map((name) => {
        const labels = {
          [scopeLabel]: project,
          "com.docker.compose.service": "agent-controller",
          ...(name === "foreign"
            ? { "com.docker.compose.project": "retained" }
            : {}),
        };
        return [
          name,
          { Name: name, Labels: labels, Config: { Labels: labels } },
        ];
      }),
    );
    const removed = [];
    const stopped = [];
    const anonymousVolumes = new Set(["foreign", "own"]);
    const docker = async (args) => {
      const selectedKind = ["ps", "inspect", "stop", "rm"].includes(args[0])
        ? "container"
        : args[0];
      if (selectedKind !== kind) return "";
      if (args[0] === "ps" || args[1] === "ls")
        return [...remaining.values()]
          .filter((value) =>
            Object.entries(value.Labels).some(
              ([key, owner]) => `label=${key}=${owner}` === args.at(-1),
            ),
          )
          .map((value) => value.Name)
          .join("\n");
      if (args[0] === "inspect" || args[1] === "inspect")
        return JSON.stringify([remaining.get(args.at(-1))]);
      if (args[0] === "stop") {
        stopped.push(args.at(-1));
        return "";
      }
      if (args[0] === "rm" || args[1] === "rm") {
        if (args[0] === "rm" && args.includes("-v"))
          anonymousVolumes.delete(args.at(-1));
        removed.push(args.at(-1));
        remaining.delete(args.at(-1));
        return "";
      }
      throw new Error("unexpected Docker command");
    };
    await assert.rejects(cleanup({ project, env: {} }, docker));
    assert.deepEqual(removed, ["own"]);
    assert.deepEqual(stopped, kind === "container" ? ["own"] : []);
    assert(remaining.has("foreign"));
    if (kind === "container") {
      assert(anonymousVolumes.has("foreign"));
      assert(
        !anonymousVolumes.has("own"),
        "owned container left its anonymous volume",
      );
    }
  });

test("awaits bounded Docker network discovery before using the synchronous IPAM selector", async () => {
  const calls = [];
  const result = await networkOctet(async (args) => {
    calls.push(args);
    return args[1] === "ls"
      ? "network-one"
      : JSON.stringify([{ IPAM: { Config: [{ Subnet: "10.242.1.0/24" }] } }]);
  }, 1);
  assert.equal(result, 2);
  assert.equal(calls.length, 2);
});

test("rejects cleanup/Compose scope outside the disposable profile", () => {
  for (const name of [
    "",
    "antnest",
    "antnest-stage3-e2e-123",
    "antnest-lifecycle-*",
  ]) {
    assert.throws(() => composeArgs(name, ["up"]));
  }
  const args = composeArgs("antnest-lifecycle-aabbccdd", ["up"]);
  assert(args.includes("/dev/null"));
  assert.equal(args.at(-1), "up");
});
test("owned resources are selected by exact Compose and runtime scope, deduplicated", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    return "one\ntwo\n";
  };
  assert.deepEqual(await owned(docker, "test-scope", "container"), [
    "one",
    "two",
  ]);
  assert.deepEqual(calls, [
    ["ps", "-aq", "--filter", "label=com.docker.compose.project=test-scope"],
    ["ps", "-aq", "--filter", `label=${scopeLabel}=test-scope`],
  ]);
});
test("failed Docker inventory never certifies absence", async () => {
  await assert.rejects(
    owned(
      async () => {
        throw new Error("Docker unavailable");
      },
      "scope",
      "volume",
    ),
  );
});

test("a failed Compose up reports why a service failed to start without credentials", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lifecycle-startup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "credentials");
  mkdirSync(join(credentials, "agent-controller", "tokens"), {
    recursive: true,
  });
  const token = "placeholder-token-xxxxxxxxxxxx";
  writeFileSync(join(credentials, "agent-controller", "tokens", "peer"), token);
  const container = {
    Id: "failed-id",
    Config: { Labels: { "com.docker.compose.service": "agent-controller" } },
    State: { Status: "exited", ExitCode: 1, OOMKilled: false },
  };
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(directory, "inspect.json"), JSON.stringify([container]));
  writeFileSync(
    join(directory, "logs.txt"),
    [
      JSON.stringify({
        level: "ERROR",
        msg: "connect Temporal",
        error: { code: "temporal_unavailable" },
      }),
      JSON.stringify({ level: "ERROR", msg: `rejected ${token}` }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
case "$1" in
  compose) echo 'dependency failed to start: container agent-controller exited (1)' >&2; exit 1 ;;
  ps) echo failed-id ;;
  inspect) cat "${directory}/inspect.json" ;;
  logs) cat "${directory}/logs.txt" ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o700 },
  );
  const docker = dockerClient(
    {
      PATH: `${bin}:${process.env.PATH}`,
      ANTNEST_SERVICE_AUTH_DIRECTORY: credentials,
    },
    undefined,
    60_000,
  );
  const failure = await docker(
    composeArgs("antnest-lifecycle-aabbccdd", ["up", "-d", "--wait"]),
    true,
  ).then(
    () => assert.fail("Compose up must fail"),
    (error) => error,
  );
  assert.match(failure.message, /dependency failed to start/);
  const summary = JSON.parse(
    failure.message
      .split("\n")
      .find((line) => line.startsWith('{"startup_failures"')),
  );
  assert.deepEqual(summary.startup_failures, [
    {
      service: "agent-controller",
      status: "exited",
      exit_code: 1,
      oom_killed: false,
      health: null,
      errors: [
        { msg: "connect Temporal", code: "temporal_unavailable" },
        { msg: "[withheld: credential]", code: null },
      ],
      crash: [],
    },
  ]);
  assert(!failure.message.includes(token));
});

test("a Docker call can run with its own environment under the client deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "docker-client-env-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\necho "$1|${OTEL_TRACES_EXPORTER:-unset}|$ANTNEST_ADMISSION_TAG"\n',
      { mode: 0o700 },
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      ANTNEST_ADMISSION_TAG: "shell-1",
      OTEL_TRACES_EXPORTER: "otlp",
    };
    const docker = dockerClient(env, undefined, 60_000);
    assert.equal(await docker(["ps"]), "ps|otlp|shell-1");
    const { OTEL_TRACES_EXPORTER: _, ...build } = env;
    assert.equal(
      await docker(["build"], true, { env: build }),
      "build|unset|shell-1",
    );
    const expired = dockerClient(env, undefined, -1);
    await assert.rejects(
      expired(["build"], true, { env: build }),
      /deadline exceeded/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit log collection preserves both streams without truncating early shutdown warnings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "docker-client-log-"));
  try {
    writeFileSync(
      join(directory, "stderr.txt"),
      "Bridge drain did not close cleanly\n" + "x".repeat(70000),
    );
    writeFileSync(
      join(directory, "docker"),
      '#!/bin/sh\necho "Agent UI Bridge listening"\ncat "$LOG_FIXTURE" >&2\n',
      { mode: 0o700 },
    );
    const docker = dockerClient(
      {
        PATH: `${directory}:${process.env.PATH}`,
        LOG_FIXTURE: join(directory, "stderr.txt"),
      },
      undefined,
      60000,
    );
    assert.equal(await docker(["logs", "owned"]), "Agent UI Bridge listening");
    const logs = await docker(["logs", "owned"], false, {
      captureStderr: true,
    });
    assert(logs.includes("Agent UI Bridge listening"));
    assert(logs.includes("Bridge drain did not close cleanly"));
    assert(logs.endsWith("x".repeat(70000)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mode of ["abort", "deadline"])
  test(`a Docker operation ${mode} terminates and joins its actual subprocess group`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "docker-operation-"));
    const receipt = join(directory, "pids.json");
    let pids;
    let work;
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      writeFileSync(
        join(directory, "docker"),
        `#!${process.execPath}
const { spawn } = require("node:child_process");
if (process.argv[2] === "quick") process.stdout.write("ready");
else {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "inherit" });
  child.once("spawn", () => require("node:fs").writeFileSync(process.env.PID_RECEIPT, JSON.stringify([process.pid, child.pid])));
  setTimeout(() => {}, 5000);
}
`,
        { mode: 0o700 },
      );
      const docker = dockerClient(
        {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          PID_RECEIPT: receipt,
        },
        undefined,
        10000,
      );
      const operation = new AbortController();
      work = docker(["sample"], false, {
        signal: operation.signal,
        timeoutMS: mode === "deadline" ? 2000 : 10000,
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const readyDeadline = Date.now() + 4000;
      while (!existsSync(receipt)) {
        assert(Date.now() < readyDeadline, "actual subprocess did not start");
        await delay(10);
      }
      pids = JSON.parse(readFileSync(receipt, "utf8"));
      assert(pids.every(alive));
      if (mode === "abort") operation.abort(new Error("operation cancelled"));
      const result = await work;
      assert(result.error, "cancelled sampling was reported as success");
      assert.match(result.error.message, /interrupted|timed out|cancelled/u);
      const reapDeadline = Date.now() + 2000;
      while (pids.some(alive) && Date.now() < reapDeadline) await delay(10);
      assert.deepEqual(pids.map(alive), [false, false]);
      assert.equal(await docker(["quick"]), "ready");
    } finally {
      if (!pids && existsSync(receipt))
        pids = JSON.parse(readFileSync(receipt, "utf8"));
      if (pids?.[0])
        try {
          process.kill(-pids[0], "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      await work;
      rmSync(directory, { recursive: true, force: true });
    }
  });
