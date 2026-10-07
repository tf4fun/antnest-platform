import assert from "node:assert/strict";
import test from "node:test";
import { runtimeControllerRead, runtimeStatus } from "./runtime-status.mjs";

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

test("Runtime status fails without leaking rejected credentials", async () => {
  const { docker } = fakeDocker("none");
  await assert.rejects(
    runtimeStatus(docker, project, "runtime-id"),
    (error) => !error.message.includes("sender-"),
  );
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
