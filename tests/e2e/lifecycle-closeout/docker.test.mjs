import assert from "node:assert/strict";
import test from "node:test";
import {
  composeArgs,
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
