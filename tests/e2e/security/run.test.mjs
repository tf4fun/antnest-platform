import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAuthenticationMatrix } from "./run.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function fixture() {
  const project = `antnest-lifecycle-${randomUUID().slice(0, 8)}`;
  const output = resolve(
    root,
    "artifacts/verification/authentication-matrix",
    project,
  );
  const agentID = `agent_${"1".repeat(32)}`;
  const calls = [];
  const config = {
    project,
    image: "antnest/antnest-runtime:local",
    env: {
      ANTNEST_EGRESS_CONTROL_SUBNET: "10.242.45.0/24",
      ANTNEST_RUNTIME_MANAGEMENT_SUBNET: "10.243.45.0/24",
    },
  };
  const dependencies = {
    configure: async () => config,
    createDocker: () => async (args) => {
      if (args.includes("up")) {
        calls.push("boot");
        assert(args.includes("--no-build"));
        assert(
          args.includes("tests/e2e/skill-learning/deployment.compose.yaml"),
        );
        assert(
          args.includes("tests/e2e/skill-learning/propagation.compose.yaml"),
        );
      }
      return "";
    },
    prepareAgent: async () => {
      calls.push("agent");
      return { agentID };
    },
    networkMatrix: async () => {
      calls.push("network");
      return [{ checks: 560 }];
    },
    authenticatedPeer: async (input) => {
      calls.push("authenticated");
      assert.equal(input.agentId, agentID);
      assert.equal(input.mode, "admission");
      return { checks: ["signed context", "Runtime admission"] };
    },
    clean: async (input) => {
      calls.push("cleanup");
      assert.equal(input, config);
    },
  };
  mkdirSync(output, { recursive: true });
  return { dependencies, calls, output };
}

test("the matrix boots production images, runs both admission gates and verifies cleanup", async () => {
  const { dependencies, calls, output } = fixture();
  try {
    const result = await runAuthenticationMatrix(dependencies);
    assert.deepEqual(calls, [
      "boot",
      "network",
      "agent",
      "authenticated",
      "cleanup",
    ]);
    assert.equal(result.status, "passed");
    assert.equal(result.network_checks, 560);
    assert.equal(result.authenticated_checks, 2);
    assert.equal(result.cleanup, "verified");
    const evidence = JSON.parse(
      readFileSync(resolve(output, "cleanup.json"), "utf8"),
    );
    assert.deepEqual(evidence.before, evidence.after);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("failed authentication still cleans the stack and preserves both failures", async () => {
  const { dependencies, calls, output } = fixture();
  const rejected = new Error("forged caller accepted");
  const cleanupFailed = new Error("cleanup failed");
  dependencies.authenticatedPeer = async () => {
    throw rejected;
  };
  dependencies.clean = async () => {
    calls.push("cleanup");
    throw cleanupFailed;
  };
  try {
    await assert.rejects(runAuthenticationMatrix(dependencies), (error) => {
      assert.deepEqual(error.errors, [rejected, cleanupFailed]);
      return true;
    });
    assert.equal(calls.at(-1), "cleanup");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a startup failure cannot skip cleanup or run either probe", async () => {
  const { dependencies, calls, output } = fixture();
  dependencies.createDocker = () => async (args) => {
    if (args.includes("up")) throw new Error("stack unhealthy");
    return "";
  };
  try {
    await assert.rejects(
      runAuthenticationMatrix(dependencies),
      /authentication matrix or cleanup failed/u,
    );
    assert.deepEqual(calls, ["cleanup"]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("retained resource changes fail the suite after cleanup", async () => {
  const { dependencies, output } = fixture();
  let cleaned = false;
  dependencies.clean = async () => {
    cleaned = true;
  };
  dependencies.createDocker = () => async (args) =>
    args[0] === "ps" && args.includes("-aq") && cleaned
      ? "foreign-container"
      : "";
  try {
    await assert.rejects(runAuthenticationMatrix(dependencies), (error) => {
      assert.match(
        error.errors[0].message,
        /preserve pre-existing Docker resources/u,
      );
      return true;
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
