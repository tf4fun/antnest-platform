import assert from "node:assert/strict";
import { test } from "node:test";

const implementation = new URL(
  "./browser-recovery-evidence.mjs",
  import.meta.url,
);
let browserEvidence = {};
try {
  browserEvidence = await import(implementation.href);
} catch (error) {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    error.url !== implementation.href
  )
    throw error;
}

function admission() {
  assert.equal(
    typeof browserEvidence.assertBrowserRecoveryRequests,
    "function",
    "original browser recovery request admission API is required",
  );
  return browserEvidence.assertBrowserRecoveryRequests;
}

function fixture({ state = "running", hostCookies = false } = {}) {
  const expected = {
    agent_id: "agent_browser_recovery",
    request_id: "rebuild_original",
    body: {
      template_id: "template_configured",
      template_revision: 1,
      recovery: {
        barrier_id: "barrier-original-\0-恢复-🧪",
        expected_runtime_revision: "runtime_original",
      },
    },
  };
  const prefix = hostCookies ? "__Host-" : "";
  const csrf = "fixture-browser-csrf-token";
  const headers = {
    cookie: `${prefix}antnest_session=fixture-browser-session; ${prefix}antnest_csrf=${csrf}`,
    "x-antnest-csrf-token": csrf,
    "content-type": "application/json",
    accept: "application/json",
  };
  const operation = {
    request_id: expected.request_id,
    agent_id: expected.agent_id,
    kind: "rebuild",
    state,
    phase: state === "completed" ? "completed" : "requested",
  };
  const agentPath = `/api/admin/agents/${encodeURIComponent(expected.agent_id)}`;
  const operationPath = `/api/admin/operations/${encodeURIComponent(expected.request_id)}`;
  const rows = [
    {
      method: "GET",
      path: agentPath,
      headers: { cookie: headers.cookie },
      body: null,
      status: 200,
      responseBody: { agent_id: expected.agent_id },
    },
    {
      method: "HEAD",
      path: agentPath,
      headers: { cookie: headers.cookie },
      body: null,
      status: 200,
      responseBody: null,
    },
    {
      method: "POST",
      path: "/api/session/activity",
      headers: structuredClone(headers),
      body: {},
      status: 204,
      responseBody: null,
    },
    {
      method: "GET",
      path: operationPath,
      headers: { cookie: headers.cookie },
      body: null,
      status: 404,
      responseBody: { code: "operation_not_found" },
    },
    {
      method: "POST",
      path: `${agentPath}/rebuild`,
      headers: { ...headers, "idempotency-key": expected.request_id },
      body: structuredClone(expected.body),
      status: 202,
      responseBody: structuredClone(operation),
    },
    {
      method: "GET",
      path: operationPath,
      headers: { cookie: headers.cookie },
      body: null,
      status: 200,
      responseBody: structuredClone(operation),
    },
  ];
  return { rows, expected };
}

function recoveryPost(input) {
  return input.rows.find(
    (row) => row.method === "POST" && row.path.endsWith("/rebuild"),
  );
}

function originalQuery(input) {
  return input.rows.find(
    (row) =>
      row.method === "GET" && row.path.startsWith("/api/admin/operations/"),
  );
}

function reject(input, label, options) {
  // Missing production admission must not make a negative vector pass.
  const check = admission();
  assert.throws(
    () => check(input.rows, input.expected, options),
    undefined,
    label,
  );
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("browser recovery provides original request inventory admission", () => {
  admission();
});

test("before-dispatch admits read-only pending checks and normal session activity", () => {
  const input = fixture();
  input.rows = input.rows.slice(0, 4);
  const check = admission();
  assert.doesNotThrow(() =>
    check(input.rows, input.expected, { beforeDispatch: true }),
  );
  assert.doesNotThrow(() =>
    check([], input.expected, { beforeDispatch: true }),
  );
});

test("browser recovery admits the original typed 404 followed by one running or completed recovery", () => {
  const check = admission();
  for (const state of ["running", "completed"]) {
    const input = fixture({ state });
    assert.doesNotThrow(() => check(input.rows, input.expected), state);
  }
});

test("browser recovery admits actual paired __Host- session and CSRF cookies", () => {
  const input = fixture({ hostCookies: true });
  const check = admission();
  assert.doesNotThrow(() => check(input.rows, input.expected));
  assert.doesNotThrow(() =>
    check(input.rows.slice(0, 4), input.expected, { beforeDispatch: true }),
  );
});

test("browser recovery admission leaves original request inventories and expectations unchanged", () => {
  const input = fixture();
  const before = structuredClone(input);
  freeze(input);
  admission()(input.rows, input.expected);
  assert.deepEqual(input, before);
});

test("completed browser recovery requires exactly one original recovery POST", () => {
  for (const duplicate of [false, true]) {
    const input = fixture();
    const post = recoveryPost(input);
    if (duplicate) input.rows.splice(5, 0, structuredClone(post));
    else input.rows = input.rows.filter((row) => row !== post);
    reject(
      input,
      duplicate ? "duplicate recovery POST" : "missing recovery POST",
    );
  }
});

test("recovery requires a typed missing result from the exact original operation query", () => {
  for (const [name, mutate] of [
    [
      "missing original query",
      (input) => {
        input.rows = input.rows.filter(
          (row) => !row.path.startsWith("/api/admin/operations/"),
        );
      },
    ],
    [
      "foreign request query",
      (input) => {
        originalQuery(input).path = "/api/admin/operations/rebuild_other";
      },
    ],
    [
      "query with extra parameters",
      (input) => {
        originalQuery(input).path += "?request_id=rebuild_other";
      },
    ],
    [
      "untyped 404",
      (input) => {
        originalQuery(input).responseBody = {};
      },
    ],
    [
      "other 404 code",
      (input) => {
        originalQuery(input).responseBody.code = "not_found";
      },
    ],
    [
      "dependency failure",
      (input) => {
        originalQuery(input).status = 503;
      },
    ],
    [
      "already existing operation",
      (input) => {
        originalQuery(input).status = 200;
        originalQuery(input).responseBody = structuredClone(
          recoveryPost(input).responseBody,
        );
      },
    ],
  ]) {
    const input = fixture();
    mutate(input);
    reject(input, name);
  }
});

test("a recovery POST cannot precede its original operation missing result", () => {
  const input = fixture();
  [input.rows[3], input.rows[4]] = [input.rows[4], input.rows[3]];
  reject(input, "a later typed 404 cannot authorize an earlier POST");
});

test("recovery POST keeps the exact original configured template, barrier and Runtime body", () => {
  for (const [name, mutate] of [
    [
      "catalog template replaces configured template",
      (body) => {
        body.template_id = "template_catalog";
      },
    ],
    [
      "catalog revision replaces configured revision",
      (body) => {
        body.template_revision = 3;
      },
    ],
    [
      "template revision type changed",
      (body) => {
        body.template_revision = "1";
      },
    ],
    [
      "barrier changed",
      (body) => {
        body.recovery.barrier_id = "barrier_other";
      },
    ],
    [
      "Runtime changed",
      (body) => {
        body.recovery.expected_runtime_revision = "runtime_other";
      },
    ],
    [
      "missing recovery tuple",
      (body) => {
        delete body.recovery;
      },
    ],
    [
      "partial recovery tuple",
      (body) => {
        delete body.recovery.barrier_id;
      },
    ],
    [
      "extra actor",
      (body) => {
        body.actor_principal_id = "other-admin";
      },
    ],
    [
      "extra organization",
      (body) => {
        body.organization_id = "other-organization";
      },
    ],
    [
      "extra recovery field",
      (body) => {
        body.recovery.execution_id = "private-execution";
      },
    ],
  ]) {
    const input = fixture();
    mutate(recoveryPost(input).body);
    reject(input, name);
  }
  for (const body of [null, [], "{}"]) {
    const input = fixture();
    recoveryPost(input).body = body;
    reject(input, "non-object recovery body");
  }
});

test("recovery POST keeps the original request key and Agent route", () => {
  for (const [name, mutate] of [
    [
      "missing request key",
      (row) => {
        delete row.headers["idempotency-key"];
      },
    ],
    [
      "empty request key",
      (row) => {
        row.headers["idempotency-key"] = "";
      },
    ],
    [
      "replacement request key",
      (row) => {
        row.headers["idempotency-key"] = "rebuild_replacement";
      },
    ],
    [
      "foreign Agent",
      (row) => {
        row.path = "/api/admin/agents/agent_other/rebuild";
      },
    ],
    [
      "extra route query",
      (row) => {
        row.path += "?action=recovery";
      },
    ],
  ]) {
    const input = fixture();
    mutate(recoveryPost(input));
    reject(input, name);
  }
});

test("recovery POST requires its own matching session-cookie and CSRF-cookie pair", () => {
  for (const hostCookies of [false, true]) {
    for (const [name, mutate] of [
      [
        "missing CSRF header",
        (headers) => {
          delete headers["x-antnest-csrf-token"];
        },
      ],
      [
        "empty CSRF header",
        (headers) => {
          headers["x-antnest-csrf-token"] = "";
        },
      ],
      [
        "CSRF mismatch",
        (headers) => {
          headers["x-antnest-csrf-token"] = "different-browser-token";
        },
      ],
      [
        "missing cookies",
        (headers) => {
          delete headers.cookie;
        },
      ],
      [
        "missing session cookie",
        (headers) => {
          headers.cookie = headers.cookie.split("; ")[1];
        },
      ],
      [
        "missing CSRF cookie",
        (headers) => {
          headers.cookie = headers.cookie.split("; ")[0];
        },
      ],
      [
        "cookie prefixes do not pair",
        (headers) => {
          headers.cookie =
            "antnest_session=fixture-browser-session; __Host-antnest_csrf=fixture-browser-csrf-token";
        },
      ],
    ]) {
      const input = fixture({ hostCookies });
      mutate(recoveryPost(input).headers);
      reject(input, `${hostCookies ? "__Host-" : "ordinary"} ${name}`);
    }
  }
});

test("accepted recovery operation must identify the original Agent, request and rebuild", () => {
  for (const [name, mutate] of [
    [
      "wrong request",
      (operation) => {
        operation.request_id = "rebuild_other";
      },
    ],
    [
      "wrong Agent",
      (operation) => {
        operation.agent_id = "agent_other";
      },
    ],
    [
      "wrong kind",
      (operation) => {
        operation.kind = "enable";
      },
    ],
    [
      "failed operation",
      (operation) => {
        operation.state = "failed";
      },
    ],
    [
      "unknown operation state",
      (operation) => {
        operation.state = "unknown";
      },
    ],
    [
      "missing operation state",
      (operation) => {
        delete operation.state;
      },
    ],
  ]) {
    const input = fixture();
    mutate(recoveryPost(input).responseBody);
    reject(input, name);
  }
  for (const responseBody of [
    null,
    {},
    { operation: fixture().rows[4].responseBody },
  ]) {
    const input = fixture();
    recoveryPost(input).responseBody = responseBody;
    reject(
      input,
      "missing or wrapped operation cannot prove recovery acceptance",
    );
  }
});

test("recovery requires an actual 202 acceptance response", () => {
  for (const status of [0, 200, 204, 400, 401, 403, 409, 500]) {
    const input = fixture();
    recoveryPost(input).status = status;
    reject(input, `recovery response status ${status}`);
  }
});

test("both phases reject any additional business mutation while retaining activity renewal", () => {
  for (const beforeDispatch of [false, true]) {
    for (const [method, path] of [
      ["POST", "/api/admin/agents/agent_other/rebuild"],
      ["POST", "/api/admin/agents/agent_browser_recovery/disable"],
      ["POST", "/api/session/logout"],
      ["PUT", "/api/admin/runtime-barrier-recovery-policy"],
      ["PATCH", "/api/admin/agents/agent_browser_recovery"],
      ["DELETE", "/api/admin/agents/agent_browser_recovery"],
    ]) {
      const input = fixture();
      if (beforeDispatch) input.rows = input.rows.slice(0, 4);
      input.rows.push({
        method,
        path,
        headers: structuredClone(input.rows[2].headers),
        body: {},
        status: 200,
        responseBody: {},
      });
      reject(
        input,
        `${beforeDispatch ? "before" : "after"} dispatch ${method} ${path}`,
        { beforeDispatch },
      );
    }
  }
});

test("before-dispatch cannot admit even one otherwise valid recovery mutation", () => {
  const input = fixture();
  reject(input, "recovery must not start during pending evidence collection", {
    beforeDispatch: true,
  });
});
