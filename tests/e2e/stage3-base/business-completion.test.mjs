import assert from "node:assert/strict";
import test from "node:test";
import {
  privateCanary,
  stage3BusinessFixture,
} from "./business-completion.fixture.mjs";

const url = new URL("./business-completion.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function complete(input, profile = "base", status = 0) {
  assert.equal(
    typeof implementation.completeStage3Business,
    "function",
    "completeStage3Business is required",
  );
  return implementation.completeStage3Business(input, { status, profile });
}
function rejectMutations(cases, profile = "base") {
  assert.doesNotThrow(() => complete(stage3BusinessFixture(profile), profile));
  for (const [label, mutate] of cases) {
    const input = stage3BusinessFixture(profile);
    mutate(input);
    assert.throws(() => complete(input, profile), label);
  }
}
const profiles = [
  "base",
  "skill-delivery",
  "restart-rebuild",
  "registry-outage",
  "offline-reuse",
];

for (const profile of profiles)
  test(`${profile} completes its original business and joined resources without any Trace report`, () => {
    const input = stage3BusinessFixture(profile),
      before = structuredClone(input);
    const result = complete(input, profile);
    assert.equal(result.status, "business_passed");
    assert.equal(result.policy_revision, 1);
    assert.equal(result.suite, "stage3-" + profile);
    assert.equal(result.agent_id, input.business.agent_id);
    assert.equal(result.cleanup, "verified");
    assert.deepEqual(input, before);
    const encoded = JSON.stringify(result);
    assert(encoded.length < 2048, "public completion must be bounded");
    assert(
      !encoded.includes(privateCanary),
      "private receipt data escaped completion",
    );
    for (const key of [
      "inventory",
      "principal",
      "requestReceipt",
      "raw_frames",
      "params",
      "runtime_operations",
      "runtime_tool_calls",
      "trace_id",
      "traceID",
    ])
      assert(!encoded.includes(`"${key}":`), key);
    for (const key of [
      "business",
      "logouts",
      "connections",
      "requests",
      "provider_requests",
      "lifecycle",
    ])
      if (Object.hasOwn(result, key))
        assert.notEqual(
          typeof result[key],
          "object",
          "private original container: " + key,
        );
  });

test("Trace fields are never read for request grouping, lifecycle or Logout business admission", () => {
  const input = stage3BusinessFixture("restart-rebuild");
  const forbidden = () => {
    throw new Error("Trace-only field was read");
  };
  const add = (row, keys) => {
    for (const key of keys)
      Object.defineProperty(row, key, { enumerable: true, get: forbidden });
  };
  for (const row of input.inventory.requests)
    add(row, ["traceID", "connectionTraceID", "clientSpanID"]);
  for (const row of input.inventory.lifecycle) add(row, ["traceID"]);
  for (const row of input.inventory.provider_requests)
    add(row, ["trace_id", "model_span_id"]);
  for (const c of input.inventory.connections) {
    add(c, ["connection_trace_id", "client_span_id"]);
    for (const row of [c.initialization, ...c.evidence])
      add(row, ["traceID", "connectionTraceID", "clientSpanID"]);
  }
  for (const row of input.logouts) {
    add(row, ["traceID", "authorizationCauseVerified"]);
    for (const original of [
      row.cause,
      row.denial,
      row.checkpoint.issuance,
      row.closingLifecycle,
    ])
      add(original, ["traceID"]);
    for (const original of [row.closure, row.checkpoint.stream])
      add(original, ["trace_id"]);
  }
  Object.defineProperty(input, "report", { enumerable: true, get: forbidden });
  assert.equal(complete(input, "restart-rebuild").status, "business_passed");
});

test("passed summary and zero exit cannot replace missing original business evidence", () => {
  rejectMutations([
    [
      "request inventory missing",
      (f) => {
        delete f.inventory.requests;
      },
    ],
    [
      "Provider inventory missing",
      (f) => {
        delete f.inventory.provider_requests;
      },
    ],
    [
      "connection originals missing",
      (f) => {
        delete f.inventory.connections;
      },
    ],
    [
      "lifecycle originals missing",
      (f) => {
        delete f.inventory.lifecycle;
      },
    ],
    [
      "Logout originals missing",
      (f) => {
        delete f.logouts;
      },
    ],
    [
      "summary alone",
      (f) => {
        f.inventory = {};
        f.logouts = [];
      },
    ],
    [
      "failed business",
      (f) => {
        f.business.status = "failed";
      },
    ],
    [
      "Agent not deleted",
      (f) => {
        f.business.deleted = false;
      },
    ],
    [
      "actual resource join not completed",
      (f) => {
        f.business.resources_joined = false;
      },
    ],
    [
      "actual resource join receipt missing",
      (f) => {
        delete f.business.resources_joined;
      },
    ],
  ]);
});

test("original request inventory must be complete and bound to its actual connection", () => {
  rejectMutations([
    [
      "missing request",
      (f) => {
        f.inventory.requests.pop();
      },
    ],
    [
      "duplicate request",
      (f) => {
        f.inventory.requests[2] = structuredClone(f.inventory.requests[1]);
      },
    ],
    [
      "missing connection",
      (f) => {
        f.inventory.connections.pop();
      },
    ],
    [
      "duplicate connection",
      (f) => {
        f.inventory.connections[1] = structuredClone(
          f.inventory.connections[0],
        );
      },
    ],
    [
      "foreign request Agent",
      (f) => {
        f.inventory.requests[1].agentId = "agent_foreign";
      },
    ],
    [
      "foreign connection Agent",
      (f) => {
        f.inventory.connections[0].agent_id = "agent_foreign";
      },
    ],
    [
      "failed request",
      (f) => {
        f.inventory.requests[2].outcome = "failed";
      },
    ],
    [
      "changed connection request",
      (f) => {
        f.inventory.connections[0].evidence[0].requestId = "replacement";
      },
    ],
    [
      "missing original request receipt",
      (f) => {
        delete f.inventory.requests[1].requestReceipt;
      },
    ],
    [
      "foreign original Session",
      (f) => {
        f.inventory.requests[2].requestReceipt.params.sessionId =
          "session_foreign";
      },
    ],
    [
      "changed original RPC identity",
      (f) => {
        f.inventory.requests[1].requestReceipt.requestId = "replacement";
      },
    ],
  ]);
});

test("original successful RPC results cannot be absent, duplicated or borrowed from another response", () => {
  rejectMutations([
    [
      "missing raw reply",
      (f) => {
        f.inventory.connections[0].raw_frames.pop();
      },
    ],
    [
      "duplicate raw reply",
      (f) => {
        f.inventory.connections[0].raw_frames.push(
          structuredClone(f.inventory.connections[0].raw_frames[1]),
        );
      },
    ],
    [
      "foreign new Session result",
      (f) => {
        f.inventory.connections[0].raw_frames[1].result.sessionId =
          "session_foreign";
      },
    ],
    [
      "raw RPC error",
      (f) => {
        const row = f.inventory.connections[0].raw_frames[2];
        delete row.result;
        row.error = { code: -32603, message: privateCanary };
      },
    ],
    [
      "changed v2 ACK message",
      (f) => {
        f.inventory.connections[2].raw_frames[2].result.messageId =
          "message_foreign";
      },
    ],
    [
      "connection still open",
      (f) => {
        f.inventory.connections[0].closed = false;
      },
    ],
  ]);
});

test("HTTP 202 and cancelled long streams require actual replies and complete transport join", () => {
  rejectMutations([
    [
      "notification stream not joined",
      (f) => {
        f.inventory.connections[4].http_connection.streamJoined = false;
      },
    ],
    [
      "request still pending",
      (f) => {
        f.inventory.connections[4].http_connection.pendingRequests = 1;
      },
    ],
    [
      "actual HTTP cleanup failure",
      (f) => {
        f.inventory.connections[4].http_connection.failures.push({
          phase: "delete_status",
        });
      },
    ],
    [
      "missing DELETE",
      (f) => {
        f.inventory.connections[4].http_connection.requests.pop();
      },
    ],
    [
      "failed DELETE",
      (f) => {
        f.inventory.connections[4].http_connection.requests.at(-1).status = 500;
      },
    ],
    [
      "body not joined",
      (f) => {
        delete f.inventory.connections[4].http_connection.requests[2].ended;
      },
    ],
  ]);
});

test("model completion inventory is bound to actual ordinary phases and unique Tool/reply pairs", () => {
  rejectMutations([
    [
      "missing model request",
      (f) => {
        f.inventory.provider_requests.pop();
      },
    ],
    [
      "duplicate model stage",
      (f) => {
        f.inventory.provider_requests[1] = structuredClone(
          f.inventory.provider_requests[0],
        );
      },
    ],
    [
      "foreign model phase",
      (f) => {
        f.inventory.provider_requests[0].phase = "not-executed";
      },
    ],
    [
      "extra model execution",
      (f) => {
        f.inventory.provider_requests.push({
          phase: "unexpected-replay",
          stage: "tool",
        });
      },
    ],
    [
      "summary hides missing model",
      (f) => {
        f.inventory.provider_requests.pop();
        f.business.model_requests -= 1;
      },
    ],
    [
      "Prompt original input changed",
      (f) => {
        f.inventory.requests[2].requestReceipt.params.prompt[0].text =
          "not-the-original-phase";
      },
    ],
  ]);
});

test("lifecycle originals and Runtime completion receipts cannot be replaced by passed flags", () => {
  rejectMutations([
    [
      "missing lifecycle",
      (f) => {
        f.inventory.lifecycle.pop();
      },
    ],
    [
      "foreign lifecycle Agent",
      (f) => {
        f.inventory.lifecycle[0].agentId = "agent_foreign";
      },
    ],
    [
      "duplicate lifecycle identity",
      (f) => {
        f.inventory.lifecycle[1].requestId = f.inventory.lifecycle[0].requestId;
      },
    ],
    [
      "wrong lifecycle order",
      (f) => {
        [f.inventory.lifecycle[1], f.inventory.lifecycle[2]] = [
          f.inventory.lifecycle[2],
          f.inventory.lifecycle[1],
        ];
      },
    ],
    [
      "uncompleted Runtime operation",
      (f) => {
        f.business.runtime_operations[0].completed = false;
      },
    ],
    [
      "wrong Runtime request",
      (f) => {
        f.business.runtime_operations[0].request_id = "acr_foreign";
      },
    ],
    [
      "duplicate target revision",
      (f) => {
        f.business.runtime_operations[1].target_revision =
          f.business.runtime_operations[0].target_revision;
      },
    ],
    [
      "summary omits lifecycle",
      (f) => {
        f.business.lifecycle_kinds.pop();
      },
    ],
  ]);
});

test("both original Logout observations are inspected and bound to actual Session creation", () => {
  rejectMutations([
    [
      "missing version",
      (f) => {
        f.logouts.pop();
      },
    ],
    [
      "duplicate version",
      (f) => {
        f.logouts[1] = structuredClone(f.logouts[0]);
      },
    ],
    [
      "foreign Logout Agent",
      (f) => {
        f.logouts[0].agentId = "agent_foreign";
      },
    ],
    [
      "Logout did not commit HTTP 204",
      (f) => {
        f.logouts[0].cause.status = 500;
      },
    ],
    [
      "denied Prompt executed",
      (f) => {
        f.logouts[1].denial.status = 200;
      },
    ],
    [
      "local close",
      (f) => {
        f.logouts[0].localClose = true;
      },
    ],
    [
      "Logout protocol client not joined",
      (f) => {
        f.logouts[0].protocolClientClosedLocally = false;
      },
    ],
    [
      "wrong Session creation reply",
      (f) => {
        const row = f.inventory.requests.find(
          (row) => row.label === "logout-v1:new",
        );
        row.requestReceipt.result.sessionId = "session_foreign";
      },
    ],
    [
      "false recovery summary",
      (f) => {
        f.business.revocations[0].recovered_empty = false;
      },
    ],
  ]);
});

test("every profile-specific business recovery remains a blocking requirement", () => {
  rejectMutations(
    [
      [
        "wrong immutable versions",
        (f) => {
          f.business.immutable_skill_versions = [1, 3];
        },
      ],
      [
        "Registry reached from Runtime",
        (f) => {
          f.business.registry_network_denial.actual_ipv4_via_antnest0 = false;
        },
      ],
      [
        "actual model denial proof absent",
        (f) => {
          delete f.inventory.provider_requests[1].registry_network_denied;
        },
      ],
    ],
    "skill-delivery",
  );
  rejectMutations(
    [
      [
        "missing restart",
        (f) => {
          delete f.business.fenced_rebuild_restart;
        },
      ],
      [
        "ACP admission stayed open",
        (f) => {
          f.business.fenced_rebuild_restart.admission_closed_during_restart = false;
        },
      ],
      [
        "wrong restarted lifecycle",
        (f) => {
          f.business.fenced_rebuild_restart.request_id = "lifecycle_foreign";
        },
      ],
    ],
    "restart-rebuild",
  );
  rejectMutations(
    [
      [
        "missing outage recovery",
        (f) => {
          delete f.business.registry_outage;
        },
      ],
      [
        "source Run did not complete",
        (f) => {
          f.business.registry_outage.source_run_completed = false;
        },
      ],
    ],
    "registry-outage",
  );
  rejectMutations(
    [
      [
        "missing offline reuse",
        (f) => {
          delete f.business.offline_skill_reuse;
        },
      ],
      [
        "offline Rebuild missing",
        (f) => {
          f.inventory.lifecycle.splice(3, 1);
        },
      ],
    ],
    "offline-reuse",
  );
});

test("new business mode accepts only successful client, archive, cleanup and outer status", () => {
  assert.doesNotThrow(() => complete(stage3BusinessFixture()));
  for (const status of [1, 2, null, "0"])
    assert.throws(
      () => complete(stage3BusinessFixture(), "base", status),
      `outer ${status}`,
    );
  assert.throws(() =>
    implementation.completeStage3Business(stage3BusinessFixture(), {
      profile: "base",
      status: undefined,
    }),
  );
  for (const key of [
    "entry_status",
    "client_status",
    "archive_status",
    "cleanup_status",
  ])
    rejectMutations([
      [
        key + " failed",
        (f) => {
          f.cleanup[key] = 1;
        },
      ],
      [
        key + " missing",
        (f) => {
          delete f.cleanup[key];
        },
      ],
    ]);
  assert.throws(() =>
    complete(stage3BusinessFixture(), "unrecognized-profile"),
  );
});
