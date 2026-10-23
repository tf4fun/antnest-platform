import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAuthenticationMatrix } from "./run.mjs";
import * as matrix from "./run.mjs";
import { scopeLabel } from "../lifecycle-closeout/docker.mjs";
import { productionOverlay } from "./stack.mjs";

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
    environment: {},
    configure: async (_signal, _beforeEffects, image) => {
      config.image = image;
      return config;
    },
    createDocker: () => async (args) => {
      const imageId = (ref) =>
        `sha256:${createHash("sha256").update(ref).digest("hex")}`;
      if (args[0] === "image") return imageId(args.at(-1));
      if (args[0] === "compose" && args.includes("ps"))
        return "all-matrix-containers";
      if (args[0] === "inspect") {
        const selection = matrix.matrixImageSelection(dependencies.environment);
        if (args[1] === `antnest-runtime-${agentID}`)
          return JSON.stringify([
            {
              Id: args[1],
              Image: imageId(selection.runtime),
              Config: {
                Image: selection.runtime,
                Labels: {
                  [scopeLabel]: project,
                  "io.antnest.agent-id": agentID,
                  "io.antnest.managed": "runtime",
                },
              },
            },
          ]);
        return JSON.stringify(
          Object.entries(selection.services).map(([service, ref]) => ({
            Id: service,
            Image: imageId(ref),
            Config: {
              Image: ref,
              Labels: {
                "com.docker.compose.project": project,
                "com.docker.compose.service": service,
              },
            },
          })),
        );
      }
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
  return { dependencies, calls, output, config };
}

const candidates = {
  ANTNEST_C4_AGENT_ACP_IMAGE: "antnest/agent-acp-service:matrix-candidate",
  ANTNEST_C4_AGENT_UI_IMAGE: "antnest/agent-ui:matrix-candidate",
  ANTNEST_C4_AGENT_CONTROLLER_IMAGE:
    "antnest/agent-controller:matrix-candidate",
  ANTNEST_C4_EDGE_GATEWAY_IMAGE: "antnest/edge-gateway:matrix-candidate",
  ANTNEST_E2E_IDENTITY_IMAGE: "antnest/identity-service:matrix-candidate",
  ANTNEST_E2E_DISCOVERY_REGISTRY_IMAGE:
    "antnest/skill-registry:matrix-candidate",
  ANTNEST_E2E_PROPAGATION_CONSOLE_IMAGE:
    "antnest/admin-console:matrix-candidate",
  ANTNEST_E2E_PROPAGATION_RC_IMAGE:
    "antnest/runtime-controller:matrix-candidate",
  ANTNEST_E2E_EGRESS_IMAGE: "antnest/runtime-egress:matrix-candidate",
  ANTNEST_E2E_TEMPORAL_IMAGE: "antnest/temporal:matrix-candidate",
  ANTNEST_E2E_RUNTIME_IMAGE: "antnest/antnest-runtime:matrix-candidate",
};

test("matrix candidate selection survives fixture filtering and supplies the private peer", async () => {
  const f = fixture();
  f.dependencies.environment = {
    ...candidates,
    ANTNEST_BOOTSTRAP_ADMIN_PASSWORD: "must-not-propagate",
  };
  f.dependencies.configure = async (_signal, _beforeEffects, runtime) => {
    assert.equal(runtime, candidates.ANTNEST_E2E_RUNTIME_IMAGE);
    f.config.image = runtime;
    return f.config;
  };
  const original = f.dependencies.authenticatedPeer;
  f.dependencies.authenticatedPeer = async (input) => {
    assert.equal(input.image, candidates.ANTNEST_C4_AGENT_ACP_IMAGE);
    assert.equal(
      input.config.env.ANTNEST_E2E_AGENT_CONTROLLER_IMAGE,
      candidates.ANTNEST_C4_AGENT_CONTROLLER_IMAGE,
    );
    assert.equal(
      input.config.env.ANTNEST_E2E_GATEWAY_IMAGE,
      candidates.ANTNEST_C4_EDGE_GATEWAY_IMAGE,
    );
    assert.equal(
      input.config.env.ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE,
      candidates.ANTNEST_E2E_PROPAGATION_RC_IMAGE,
    );
    assert.equal(input.config.env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD, undefined);
    return original(input);
  };
  try {
    await runAuthenticationMatrix(f.dependencies);
  } finally {
    rmSync(f.output, { recursive: true, force: true });
  }
});

test("conflicting candidate aliases fail before fixture side effects", async () => {
  let configured = false;
  await assert.rejects(
    runAuthenticationMatrix({
      environment: {
        ...candidates,
        ANTNEST_E2E_AGENT_CONTROLLER_IMAGE: "antnest/agent-controller:other",
      },
      configure: () => {
        configured = true;
        throw new Error("must not configure");
      },
    }),
    /conflicting.*IMAGE/u,
  );
  assert.equal(configured, false);
});

test("matrix verifies actual Compose and native Runtime image IDs, not tag names alone", async () => {
  const selection = matrix.matrixImageSelection(candidates);
  const id = (ref) =>
    `sha256:${createHash("sha256").update(ref).digest("hex")}`;
  const expected = Object.fromEntries(
    Object.entries(selection.services).map(([service, ref]) => [
      service,
      { ref, id: id(ref) },
    ]),
  );
  expected.runtime = { ref: selection.runtime, id: id(selection.runtime) };
  const project = "antnest-lifecycle-1234abcd",
    agentID = `agent_${"1".repeat(32)}`;
  const containers = Object.entries(expected).map(([service, image]) => ({
    Id:
      service === "runtime"
        ? `antnest-runtime-${agentID}`
        : `container-${service}`,
    Image: image.id,
    Config: {
      Image: image.ref,
      Labels:
        service === "runtime"
          ? {
              [scopeLabel]: project,
              "io.antnest.agent-id": agentID,
              "io.antnest.managed": "runtime",
            }
          : {
              "com.docker.compose.project": project,
              "com.docker.compose.service": service,
            },
    },
  }));
  let altered = false;
  const docker = async (args) => {
    if (args[0] === "compose")
      return containers
        .filter((c) => c.Id.startsWith("container-"))
        .map((c) => c.Id)
        .join("\n");
    assert.equal(args[0], "inspect");
    return JSON.stringify(
      containers
        .filter((c) => args.slice(1).includes(c.Id))
        .map((c) =>
          altered && c.Id === "container-agent-controller"
            ? { ...c, Image: id("stale-image") }
            : c,
        ),
    );
  };
  const input = { docker, config: { project }, expected, agentId: agentID };
  const receipt = await matrix.inspectMatrixImages(input);
  assert.equal(receipt.length, 11);
  altered = true;
  await assert.rejects(matrix.inspectMatrixImages(input), /image ID/u);
});

for (const [label, key, value] of [
  ["foreign Agent", "io.antnest.agent-id", `agent_${"f".repeat(32)}`],
  ["missing Agent", "io.antnest.agent-id", undefined],
  ["foreign managed kind", "io.antnest.managed", "helper"],
  ["missing managed kind", "io.antnest.managed", undefined],
])
  test(`same-scope, same-image Runtime with ${label} fails before authentication and still cleans up`, async () => {
    const f = fixture();
    const normalDocker = f.dependencies.createDocker();
    f.dependencies.createDocker = () => async (args) => {
      const result = await normalDocker(args);
      if (args[0] !== "inspect" || !args[1].startsWith("antnest-runtime-"))
        return result;
      const containers = JSON.parse(result);
      if (value === undefined) delete containers[0].Config.Labels[key];
      else containers[0].Config.Labels[key] = value;
      return JSON.stringify(containers);
    };
    try {
      await assert.rejects(runAuthenticationMatrix(f.dependencies), (error) => {
        assert.match(error.errors[0].message, /Runtime (Agent|managed)/u);
        return true;
      });
      assert(!f.calls.includes("authenticated"));
      assert.equal(f.calls.at(-1), "cleanup");
    } finally {
      rmSync(f.output, { recursive: true, force: true });
    }
  });

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
  const normalDocker = dependencies.createDocker();
  dependencies.createDocker = () => async (args) => {
    if (args.includes("up")) throw new Error("stack unhealthy");
    return normalDocker(args);
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
  const normalDocker = dependencies.createDocker();
  dependencies.createDocker = () => async (args) =>
    args[0] === "ps" && args.includes("-aq") && cleaned
      ? "foreign-container"
      : normalDocker(args);
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

const ownerOverlay = "tests/e2e/security/owner.compose.yaml";

function ownerFixture({
  enabled = true,
  held = false,
  failAt,
  cleanupError,
} = {}) {
  const f = fixture();
  const gates = Object.fromEntries(
    ["prepare-owner", "registration", "owner-business"].map((name) => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      if (!held) release.resolve();
      return [name, { entered, release }];
    }),
  );
  const hookTasks = [];
  const compose = [];
  const overlayBefore = [...productionOverlay];
  let signal;
  let primaryDocker;
  let prepared;
  const originalConfigure = f.dependencies.configure;
  const originalDocker = f.dependencies.createDocker;
  const originalPrepare = f.dependencies.prepareAgent;
  const originalClean = f.dependencies.clean;
  f.dependencies.configure = async (...args) => {
    f.calls.push("configure");
    signal = args[0];
    return originalConfigure(...args);
  };
  f.dependencies.createDocker = (...options) => {
    const docker = originalDocker(...options);
    const tracked = async (args, ...rest) => {
      if (
        args[0] === "compose" &&
        (args.includes("up") || args.includes("ps"))
      ) {
        compose.push([...args]);
        if (args.includes("up")) {
          if (enabled)
            assert.deepEqual(f.config.ownerProfiles, ["acp-owner-bootstrap"]);
          else assert.equal(f.config.ownerProfiles, undefined);
        } else f.calls.push("inspect-images");
      }
      return docker(args, ...rest);
    };
    primaryDocker ??= tracked;
    return tracked;
  };
  f.dependencies.prepareAgent = async (...args) => {
    prepared = await originalPrepare(...args);
    return prepared;
  };
  const hook =
    (name, work) =>
    (...args) => {
      const task = (async () => {
        f.calls.push(name);
        gates[name].entered.resolve();
        await gates[name].release.promise;
        if (failAt?.name === name) throw failAt.error;
        const result = work(...args);
        f.calls.push(`${name}-complete`);
        return result;
      })();
      hookTasks.push(task);
      void task.catch(() => {});
      return task;
    };
  const assertInput = (input) => {
    assert.equal(input.config, f.config);
    assert.equal(input.docker, primaryDocker);
    assert.equal(input.root, root);
    assert.equal(input.output, f.output);
    assert.equal(input.signal, signal);
    assert.equal(input.signal.aborted, false);
  };
  f.dependencies.prepareOwner = hook("prepare-owner", (config) => {
    assert.equal(config, f.config);
    config.ownerProfiles = ["acp-owner-bootstrap"];
  });
  f.dependencies.ownerRegistration = hook("registration", (input) => {
    assertInput(input);
    return { status: "passed", checks: ["original owner registration"] };
  });
  f.dependencies.ownerBusiness = hook("owner-business", (input) => {
    assertInput(input);
    assert.equal(input.fixture, prepared);
    assert.equal(input.fixture.agentID, `agent_${"1".repeat(32)}`);
    return { status: "passed", checks: ["owner business"] };
  });
  f.dependencies.clean = async (config) => {
    await originalClean(config);
    if (cleanupError) throw cleanupError;
  };
  return {
    ...f,
    gates,
    compose,
    overlayBefore,
    async joinHooks() {
      for (const gate of Object.values(gates)) gate.release.resolve();
      await Promise.allSettled(hookTasks);
    },
  };
}

function composeFiles(args) {
  return args.flatMap((value, index) =>
    value === "-f" ? [args[index + 1]] : [],
  );
}

async function enteredBeforeCompletion(entered, operation, label) {
  let timer;
  try {
    await Promise.race([
      entered,
      operation.then(() => {
        throw new Error(`${label} was not entered before matrix completion`);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} was not entered`)),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const selected of [undefined, false]) {
  test(`matrix leaves owner hooks and overlay unused when ownerProfile is ${selected === undefined ? "omitted" : "false"}`, async () => {
    const f = ownerFixture({ enabled: false });
    try {
      const result = await runAuthenticationMatrix({
        ...f.dependencies,
        ...(selected === undefined ? {} : { ownerProfile: selected }),
      });
      assert.equal(result.status, "passed");
      assert.deepEqual(f.calls, [
        "configure",
        "boot",
        "network",
        "agent",
        "inspect-images",
        "authenticated",
        "cleanup",
      ]);
      assert.equal(f.config.ownerProfiles, undefined);
      assert(f.compose.length > 0);
      assert(f.compose.every((args) => !args.includes(ownerOverlay)));
      assert.deepEqual(productionOverlay, f.overlayBefore);
    } finally {
      await f.joinHooks();
      rmSync(f.output, { recursive: true, force: true });
    }
  });
}

for (const ownerProfile of [null, "true", 1, {}]) {
  test(`matrix rejects nonboolean ownerProfile ${JSON.stringify(ownerProfile)} before configuration`, async () => {
    const f = ownerFixture();
    try {
      await assert.rejects(
        runAuthenticationMatrix({ ...f.dependencies, ownerProfile }),
      );
      assert.deepEqual(f.calls, []);
      assert.equal(existsSync(resolve(f.output, "result.json")), false);
    } finally {
      await f.joinHooks();
      rmSync(f.output, { recursive: true, force: true });
    }
  });
}

test("owner matrix awaits preparation, registration and business in the original admission sequence", async () => {
  const f = ownerFixture({ held: true });
  const operation = runAuthenticationMatrix({
    ...f.dependencies,
    ownerProfile: true,
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  try {
    await enteredBeforeCompletion(
      f.gates["prepare-owner"].entered.promise,
      operation,
      "owner preparation",
    );
    assert.deepEqual(f.calls, ["configure", "prepare-owner"]);
    assert.equal(
      f.compose.length,
      0,
      "Compose started before owner preparation completed",
    );
    f.gates["prepare-owner"].release.resolve();
    await enteredBeforeCompletion(
      f.gates.registration.entered.promise,
      operation,
      "owner registration",
    );
    assert.deepEqual(f.calls, [
      "configure",
      "prepare-owner",
      "prepare-owner-complete",
      "boot",
      "registration",
    ]);
    assert.equal(f.compose.filter((args) => args.includes("up")).length, 1);
    f.gates.registration.release.resolve();
    await enteredBeforeCompletion(
      f.gates["owner-business"].entered.promise,
      operation,
      "owner business",
    );
    assert.deepEqual(f.calls, [
      "configure",
      "prepare-owner",
      "prepare-owner-complete",
      "boot",
      "registration",
      "registration-complete",
      "network",
      "agent",
      "inspect-images",
      "authenticated",
      "owner-business",
    ]);
    assert.equal(existsSync(resolve(f.output, "result.json")), false);
    f.gates["owner-business"].release.resolve();
    const outcome = await operation;
    if (!outcome.ok) throw outcome.error;
    assert.equal(outcome.value.status, "passed");
    assert.deepEqual(f.calls, [
      "configure",
      "prepare-owner",
      "prepare-owner-complete",
      "boot",
      "registration",
      "registration-complete",
      "network",
      "agent",
      "inspect-images",
      "authenticated",
      "owner-business",
      "owner-business-complete",
      "cleanup",
    ]);
    const up = f.compose.filter((args) => args.includes("up"));
    const inspect = f.compose.filter((args) => args.includes("ps"));
    assert.equal(up.length, 1);
    assert.equal(inspect.length, 1);
    assert.deepEqual(
      composeFiles(inspect[0]),
      composeFiles(up[0]),
      "image inspection omitted the selected owner overlay",
    );
    assert.equal(composeFiles(up[0]).at(-1), ownerOverlay);
    assert.equal(
      composeFiles(up[0]).filter((file) => file === ownerOverlay).length,
      1,
    );
    assert.deepEqual(
      productionOverlay,
      f.overlayBefore,
      "owner mode mutated the default production overlay",
    );
  } finally {
    for (const gate of Object.values(f.gates)) gate.release.resolve();
    await operation;
    await f.joinHooks();
    rmSync(f.output, { recursive: true, force: true });
  }
});

test("SIGTERM during the last owner business await joins late success and cleanup without passing", async () => {
  const f = ownerFixture();
  const businessEntered = Promise.withResolvers(),
    businessRelease = Promise.withResolvers(),
    cleanupEntered = Promise.withResolvers(),
    cleanupRelease = Promise.withResolvers();
  let businessTask,
    cleanupTask,
    signal,
    businessCompleted = false,
    cleanupStarted = false,
    cleanupCompleted = false,
    settled = false;
  f.dependencies.ownerBusiness = (input) => {
    signal = input.signal;
    assert.equal(signal.aborted, false);
    assert.equal(input.config, f.config);
    assert.equal(input.output, f.output);
    assert.equal(input.fixture.agentID, `agent_${"1".repeat(32)}`);
    f.calls.push("owner-business");
    businessTask = (async () => {
      businessEntered.resolve();
      await businessRelease.promise;
      businessCompleted = true;
      f.calls.push("owner-business-complete");
      return {
        status: "passed",
        agent_id: input.fixture.agentID,
        session_id: `session_${"2".repeat(32)}`,
        run_id: `run_${"3".repeat(32)}`,
        executor_state: "quiescent",
      };
    })();
    return businessTask;
  };
  const originalClean = f.dependencies.clean;
  f.dependencies.clean = (config) => {
    cleanupTask = (async () => {
      cleanupStarted = true;
      cleanupEntered.resolve();
      await cleanupRelease.promise;
      await originalClean(config);
      cleanupCompleted = true;
    })();
    return cleanupTask;
  };
  const operation = runAuthenticationMatrix({
    ...f.dependencies,
    ownerProfile: true,
  }).then(
    (value) => {
      settled = true;
      return { ok: true, value };
    },
    (error) => {
      settled = true;
      return { ok: false, error };
    },
  );
  try {
    await enteredBeforeCompletion(
      businessEntered.promise,
      operation,
      "last owner business await",
    );
    assert.equal(process.emit("SIGTERM"), true);
    assert.equal(signal.aborted, true);
    const primary = signal.reason;
    assert(primary instanceof Error);
    assert.equal(primary.message, "Authentication matrix interrupted");
    await new Promise((complete) => setImmediate(complete));
    assert.equal(
      settled,
      false,
      "SIGTERM discarded the original business task",
    );
    assert.equal(businessCompleted, false);
    assert.equal(cleanupStarted, false);
    assert.equal(existsSync(resolve(f.output, "result.json")), false);
    businessRelease.resolve();
    await enteredBeforeCompletion(
      cleanupEntered.promise,
      operation,
      "interrupted owner cleanup",
    );
    assert.equal(businessCompleted, true);
    assert.equal(settled, false, "matrix completed before cleanup joined");
    assert.equal(cleanupCompleted, false);
    assert.equal(existsSync(resolve(f.output, "result.json")), false);
    cleanupRelease.resolve();
    const outcome = await operation;
    assert.equal(cleanupCompleted, true);
    assert.equal(f.calls.filter((call) => call === "cleanup").length, 1);
    assert.equal(outcome.ok, false, "late owner success swallowed SIGTERM");
    assert(outcome.error instanceof AggregateError);
    assert(outcome.error.errors.includes(primary));
    assert.equal(
      existsSync(resolve(f.output, "result.json")),
      false,
      "interrupted owner admission wrote a passing matrix result",
    );
  } finally {
    businessRelease.resolve();
    cleanupRelease.resolve();
    await operation;
    await businessTask;
    await cleanupTask;
    await f.joinHooks();
    rmSync(f.output, { recursive: true, force: true });
  }
});

for (const name of ["prepare-owner", "registration", "owner-business"]) {
  for (const cleanupFails of [false, true]) {
    test(`owner ${name} failure still cleans and preserves ${cleanupFails ? "both errors" : "the original error"}`, async () => {
      const primary = new Error(`${name} failed`);
      const cleanupError = cleanupFails
        ? new Error("owner matrix cleanup failed")
        : undefined;
      const f = ownerFixture({
        failAt: { name, error: primary },
        cleanupError,
      });
      try {
        await assert.rejects(
          runAuthenticationMatrix({ ...f.dependencies, ownerProfile: true }),
          (error) => {
            assert(error instanceof AggregateError);
            assert.deepEqual(
              error.errors,
              cleanupFails ? [primary, cleanupError] : [primary],
            );
            return true;
          },
        );
        const expected = ["configure", "prepare-owner"];
        if (name !== "prepare-owner")
          expected.push("prepare-owner-complete", "boot", "registration");
        if (name === "owner-business")
          expected.push(
            "registration-complete",
            "network",
            "agent",
            "inspect-images",
            "authenticated",
            "owner-business",
          );
        expected.push("cleanup");
        assert.deepEqual(
          f.calls,
          expected,
          "a failed or unvisited owner step was counted as executed",
        );
        assert.equal(
          existsSync(resolve(f.output, "result.json")),
          false,
          "failed owner admission wrote a passing matrix result",
        );
        assert.deepEqual(productionOverlay, f.overlayBefore);
      } finally {
        await f.joinHooks();
        rmSync(f.output, { recursive: true, force: true });
      }
    });
  }
}
