import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectOwnerRegistration,
  readOwnerRegistration,
} from "./owner-registration.mjs";

const project = "antnest-lifecycle-1234abcd";
const containerId = "ab".repeat(32);
const registrationId = "01234567-89ab-4cde-8fab-0123456789ab";
const incarnationId = "12345678-9abc-4def-9abc-123456789abc";
const startedAt = "2026-10-23T12:34:56.123456700Z";
const engineId = "engine-owner-registration-1";

function fixture() {
  return {
    config: {
      project,
      env: {
        ANTNEST_SERVICE_AUTH_UID: "12345",
        ANTNEST_SERVICE_AUTH_GID: "23456",
        ANTNEST_RUNTIME_CONTROLLER_SCOPE: project,
      },
    },
    engineId,
    acp: {
      Id: containerId,
      Config: {
        Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.service": "agent-acp-service",
        },
      },
      State: { Running: true, StartedAt: startedAt },
    },
    controller: {
      Id: "cd".repeat(32),
      Config: {
        User: "12345:23456",
        Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.service": "runtime-controller",
        },
      },
      State: { Running: true, StartedAt: "2026-10-23T12:34:55Z" },
    },
    // The query exposes only the digest length, never the private digest.
    // Column names follow runtime_controller.acp_incarnation_registrations.
    registrations: [
      {
        controller_scope: project,
        registration_id: registrationId,
        member_id: "acp-a",
        incarnation_id: incarnationId,
        nonce_digest_bytes: 32,
        engine_id: engineId,
        container_id: containerId,
        started_at: "2026-10-23T12:34:56.1234567Z",
        stop_receipt_id: null,
        stop_reason: null,
        stopped_at: null,
      },
    ],
  };
}

function accepted(input) {
  const before = structuredClone(input);
  const result = inspectOwnerRegistration(input);
  assert(result && typeof result === "object");
  assert.equal(result.registration_id, registrationId);
  assert.equal(result.member_id, "acp-a");
  assert.equal(result.incarnation_id, incarnationId);
  assert.equal(result.container_id, containerId);
  assert.deepEqual(
    input,
    before,
    "registration inspection changed its source evidence",
  );
}

test("one live persisted owner registration binds the exact scoped ACP process and private RC user", () => {
  accepted(fixture());
});

test("registration inspection requires exactly one persisted row", () => {
  for (const registrations of [
    null,
    {},
    [],
    [fixture().registrations[0], fixture().registrations[0]],
  ]) {
    assert.throws(() =>
      inspectOwnerRegistration({ ...fixture(), registrations }),
    );
  }
  const input = fixture();
  input.registrations.push({
    ...input.registrations[0],
    controller_scope: "antnest-lifecycle-deadbeef",
  });
  assert.throws(
    () => inspectOwnerRegistration(input),
    "a foreign second row was silently filtered away",
  );
});

test("every required persisted field must be present, including the three explicit null stop fields", () => {
  for (const field of Object.keys(fixture().registrations[0])) {
    const input = fixture();
    delete input.registrations[0][field];
    assert.throws(() => inspectOwnerRegistration(input), `missing ${field}`);
  }
});

for (const [field, invalid] of [
  ["controller_scope", ["antnest-lifecycle-deadbeef", "", null]],
  ["member_id", ["acp-b", "ACP-a", "acp-a\n", null]],
  ["nonce_digest_bytes", [0, 31, 33, "32", null]],
  ["engine_id", ["different-engine", "", null]],
  [
    "container_id",
    [
      "ef".repeat(32),
      containerId.slice(0, 12),
      containerId.toUpperCase(),
      null,
    ],
  ],
  ["started_at", ["2026-10-23T12:34:57.1234567Z", "not-a-timestamp", "", null]],
  ["stop_receipt_id", ["23456789-abcd-4ef0-abcd-23456789abcd", "", undefined]],
  [
    "stop_reason",
    [
      "container_stopped",
      "container_restarted",
      "container_removed",
      "",
      undefined,
    ],
  ],
  ["stopped_at", ["2026-10-23T12:35:00Z", "", undefined]],
]) {
  test(`registration inspection rejects a wrong ${field}`, () => {
    for (const value of invalid) {
      const input = fixture();
      input.registrations[0][field] = value;
      assert.throws(
        () => inspectOwnerRegistration(input),
        `${field}: ${String(value)}`,
      );
    }
  });
}

for (const field of ["registration_id", "incarnation_id"]) {
  test(`registration inspection requires a full canonical lowercase UUIDv4 ${field}`, () => {
    const valid = fixture().registrations[0][field];
    for (const value of [
      "not-a-uuid",
      valid.toUpperCase(),
      valid.slice(0, 14) + "1" + valid.slice(15),
      valid.slice(0, 19) + "7" + valid.slice(20),
      valid.slice(0, -1),
      valid + "\n",
      null,
      1,
    ]) {
      const input = fixture();
      input.registrations[0][field] = value;
      assert.throws(() => inspectOwnerRegistration(input));
    }
  });
}

test("an already stopped registration cannot identify the currently running ACP process", () => {
  const input = fixture();
  Object.assign(input.registrations[0], {
    stop_receipt_id: "23456789-abcd-4ef0-abcd-23456789abcd",
    stop_reason: "container_stopped",
    stopped_at: "2026-10-23T12:35:00Z",
  });
  assert.throws(() => inspectOwnerRegistration(input));
});

for (const [key, service] of [
  ["acp", "agent-acp-service"],
  ["controller", "runtime-controller"],
]) {
  test(`registration inspection rejects a foreign, missing or stopped ${key} container`, () => {
    for (const change of [
      (container) => {
        container.Config.Labels["com.docker.compose.project"] =
          "antnest-lifecycle-deadbeef";
      },
      (container) => {
        delete container.Config.Labels["com.docker.compose.project"];
      },
      (container) => {
        container.Config.Labels["com.docker.compose.service"] =
          `${service}-foreign`;
      },
      (container) => {
        delete container.Config.Labels["com.docker.compose.service"];
      },
      (container) => {
        delete container.Config.Labels;
      },
      (container) => {
        container.State.Running = false;
      },
      (container) => {
        container.State.Running = "true";
      },
      (container) => {
        delete container.State.Running;
      },
      (container) => {
        delete container.State;
      },
    ]) {
      const input = fixture();
      change(input[key]);
      assert.throws(() => inspectOwnerRegistration(input));
    }
    for (const container of [null, undefined]) {
      assert.throws(() =>
        inspectOwnerRegistration({ ...fixture(), [key]: container }),
      );
    }
  });
}

test("the RC inspect user must match both configured numeric credential UID and GID", () => {
  for (const user of [
    "54321:23456",
    "12345:65432",
    "12345",
    "root",
    "",
    null,
    undefined,
  ]) {
    const input = fixture();
    input.controller.Config.User = user;
    assert.throws(() => inspectOwnerRegistration(input));
  }
  for (const field of [
    "ANTNEST_SERVICE_AUTH_UID",
    "ANTNEST_SERVICE_AUTH_GID",
  ]) {
    const input = fixture();
    delete input.config.env[field];
    assert.throws(() => inspectOwnerRegistration(input));
  }
});

test("matching foreign scope, empty engine identity or truncated container identity cannot substitute for observed ownership", () => {
  for (const change of [
    (input) => {
      input.config.env.ANTNEST_RUNTIME_CONTROLLER_SCOPE =
        "antnest-lifecycle-deadbeef";
      input.registrations[0].controller_scope = "antnest-lifecycle-deadbeef";
    },
    (input) => {
      delete input.config.env.ANTNEST_RUNTIME_CONTROLLER_SCOPE;
    },
    (input) => {
      input.engineId = "";
      input.registrations[0].engine_id = "";
    },
    (input) => {
      delete input.engineId;
      delete input.registrations[0].engine_id;
    },
    (input) => {
      input.acp.Id = containerId.slice(0, 12);
      input.registrations[0].container_id = input.acp.Id;
    },
    (input) => {
      input.acp.Id = containerId.toUpperCase();
      input.registrations[0].container_id = input.acp.Id;
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => inspectOwnerRegistration(input));
  }
});

for (const [dockerStart, storedStart] of [
  ["2026-10-23T12:34:56.123456700Z", "2026-10-23T12:34:56.1234567Z"],
  ["2026-10-23T12:34:56.1234567Z", "2026-10-23T12:34:56.123456700Z"],
  ["2026-10-23T12:34:56.000000000Z", "2026-10-23T12:34:56Z"],
  ["2026-10-23T12:34:56Z", "2026-10-23T12:34:56.000000000Z"],
]) {
  test(`registration start preserves nanosecond equivalence between ${dockerStart} and ${storedStart}`, () => {
    const input = fixture();
    input.acp.State.StartedAt = dockerStart;
    input.registrations[0].started_at = storedStart;
    accepted(input);
  });
}

test("one nanosecond of process start drift is rejected even inside the same JavaScript millisecond", () => {
  const input = fixture();
  input.acp.State.StartedAt = "2026-10-23T12:34:56.123456700Z";
  input.registrations[0].started_at = "2026-10-23T12:34:56.123456701Z";
  assert.throws(() => inspectOwnerRegistration(input));
});

test("matching malformed process start strings cannot manufacture a Docker start identity", () => {
  for (const value of [
    "not-a-timestamp",
    "2026-02-30T12:34:56Z",
    "2026-10-23T12:34:56.1234567000Z",
    startedAt + "\n",
    "",
    null,
  ]) {
    const input = fixture();
    input.acp.State.StartedAt = value;
    input.registrations[0].started_at = value;
    assert.throws(() => inspectOwnerRegistration(input));
  }
});

test("the registration reader uses the owning role and a fixed read-only query before validating actual containers", async () => {
  const input = fixture();
  const postgres = {
    Id: "ef".repeat(32),
    Config: {
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": "postgres",
      },
    },
    State: { Running: true },
  };
  const byService = {
    "agent-acp-service": input.acp,
    "runtime-controller": input.controller,
    postgres,
  };
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "compose" && args.includes("ps"))
      return byService[args.at(-1)].Id;
    if (args[0] === "inspect")
      return JSON.stringify([
        Object.values(byService).find((c) => c.Id === args[1]),
      ]);
    if (args[0] === "info") return engineId;
    assert.equal(args[0], "exec");
    assert(args.includes(postgres.Id));
    assert(
      args.some(
        (x) =>
          x.includes("default_transaction_read_only=on") &&
          x.includes("statement_timeout=15000"),
      ),
    );
    assert.equal(args[args.indexOf("-U") + 1], "antnest_runtime_controller");
    assert.equal(args[args.indexOf("-d") + 1], "antnest_runtime_controller");
    const query = args[args.indexOf("-c") + 1];
    assert(query.includes("runtime_controller.acp_incarnation_registrations"));
    assert(query.includes("octet_length(nonce_digest)"));
    assert(
      !query
        .replace("octet_length(nonce_digest)", "")
        .includes("nonce_digest,"),
    );
    assert(query.includes(project));
    assert(!/UPDATE|DELETE|INSERT|TRUNCATE/u.test(query));
    return JSON.stringify(input.registrations);
  };
  const result = await readOwnerRegistration({ config: input.config, docker });
  assert.equal(result.registration_id, registrationId);
  assert.equal(calls.filter((args) => args[0] === "exec").length, 1);
});
