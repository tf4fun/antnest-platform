import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAuthenticationMatrix } from "./run.mjs";
import * as matrix from "./run.mjs";
import { scopeLabel } from "../lifecycle-closeout/docker.mjs";

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
