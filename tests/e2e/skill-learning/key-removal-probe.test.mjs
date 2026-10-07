import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acpRuntimeCredentials,
  keyRemovalArgs,
  runKeyRemovalProbe,
} from "./key-removal-probe.mjs";

const base = {
  name: "p-key-probe",
  project: "p",
  network: "p_runtime-management",
  agentId: "agent_abc",
  runtimeIp: "10.0.0.9",
  oldKey: "old-der",
  nextKey: "next-der",
  image: "antnest/agent-acp-service:skill-learning-x",
  credentials: "/tmp/probe/runtime-tokens",
};

test("the probe reaches the Runtime by its admitted alias, pinned to the inspected address", () => {
  const args = keyRemovalArgs(base);
  const pin = args.indexOf("--add-host");
  assert.equal(args[pin + 1], "antnest-runtime-agent_abc:10.0.0.9");
  assert.equal(args[args.indexOf("--network") + 1], "p_runtime-management");
  assert(!args.includes("ANTNEST_E2E_RUNTIME_IP=10.0.0.9"));
});

test("ACP credentials are mounted read-only and never passed as arguments", () => {
  const args = keyRemovalArgs(base);
  assert(
    args.includes(
      "type=bind,src=/tmp/probe/runtime-tokens,dst=/proof/runtime-tokens,readonly",
    ),
  );
  assert.match(args[args.indexOf("--user") + 1], /^\d+:\d+$/u);
  assert(!args.some((value) => value.includes("token-secret")));
});

test("flags and container removal are explicit", () => {
  const plain = keyRemovalArgs(base);
  assert(!plain.includes("--rm"));
  const flagged = keyRemovalArgs({
    ...base,
    flag: "ANTNEST_E2E_EXPECT_OLD_TRUSTED",
    remove: true,
  });
  assert(flagged.includes("--rm"));
  assert(flagged.includes("ANTNEST_E2E_EXPECT_OLD_TRUSTED=true"));
  assert.throws(() => keyRemovalArgs({ ...base, flag: "OTHER" }));
});

test("credential discovery waits for a recreated ACP and then fails closed", async () => {
  let calls = 0;
  const docker = async (args) => {
    assert.deepEqual(args.slice(0, 2), ["exec", "acp-1"]);
    return ++calls < 3 ? "\n" : "token-a\ntoken-b\n";
  };
  assert.deepEqual(
    await acpRuntimeCredentials(docker, "acp-1", {
      timeoutMs: 5000,
      pollMs: 1,
    }),
    ["token-a", "token-b"],
  );
  await assert.rejects(
    acpRuntimeCredentials(async () => "", "acp-1", {
      timeoutMs: 5,
      pollMs: 1,
    }),
    /ACP holds no Runtime credential/u,
  );
});

test("the offline probe does not require ACP credentials", async () => {
  const seen = [];
  const docker = async (args) => {
    seen.push(args[0]);
    return '{"status":"runtime_stopped"}\n';
  };
  const result = await runKeyRemovalProbe({
    ...base,
    credentials: undefined,
    docker,
    acpContainer: "acp-1",
    flag: "ANTNEST_E2E_EXPECT_RUNTIME_OFFLINE",
  });
  assert.equal(result.status, "runtime_stopped");
  assert.deepEqual(seen, ["run"]);
});
