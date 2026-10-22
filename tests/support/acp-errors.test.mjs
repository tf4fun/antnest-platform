import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = JSON.parse(
  readFileSync(
    new URL("../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  ),
);
const helperURL = new URL("./acp-errors.mjs", import.meta.url);
const implementation = await import(helperURL.href).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== helperURL.href)
    throw error;
  return {};
});
const definitions = Object.entries(catalog.errors);
const admissionDefinitions = definitions.filter(([, entry]) =>
  entry.surfaces.includes("admission"),
);
const backoffCodes = [
  "agent_busy",
  "session_busy",
  "configuration_not_ready",
  "agent_preparing",
  "recovery_pending",
];
const privateMessage = "PRIVATE_DATABASE_CREDENTIAL_AND_UPSTREAM_MESSAGE";

function api() {
  for (const name of [
    "assertErrorCapability",
    "assertAdmissionError",
    "admissionErrorReceipt",
  ]) {
    assert.equal(
      typeof implementation[name],
      "function",
      `${name} is exported`,
    );
  }
  return implementation;
}

function canonicalReceipt(code) {
  const entry = catalog.errors[code];
  return {
    code: entry.json_rpc_code,
    message: entry.message,
    data: {
      code,
      retryable: entry.retryable,
      ...(Object.hasOwn(entry, "retry_after_ms")
        ? { retry_after_ms: entry.retry_after_ms }
        : {}),
    },
  };
}

const criticalReceipts = [
  {
    code: -32030,
    message: "Agent already has an active Run",
    data: { code: "agent_busy", retryable: true, retry_after_ms: 1000 },
  },
  {
    code: -32036,
    message: "Previous Runtime execution requires recovery before new work",
    data: { code: "runtime_barrier_required", retryable: true },
  },
  {
    code: -32035,
    message: "Agent execution is unavailable",
    data: { code: "agent_unavailable", retryable: true },
  },
  {
    code: -32011,
    message: "Session access is not allowed",
    data: { code: "session_access_denied", retryable: false },
  },
  {
    code: -32602,
    message: "Resource content is not supported",
    data: { code: "unsupported_resource_content", retryable: false },
  },
];

test("the shared error helper exposes the three business assertion APIs", () => {
  api();
});

for (const [label, initializeResult] of [
  ["minimal", { _meta: { "antnest.dev/errors": { version: 1 } } }],
  [
    "with unrelated initialization metadata",
    {
      protocolVersion: 2,
      agentCapabilities: { loadSession: true },
      _meta: {
        "antnest.dev/errors": { version: 1 },
        "antnest.dev/execution": { version: 1 },
      },
    },
  ],
]) {
  test(`accepts ${label} top-level errors capability without changing the result`, () => {
    const { assertErrorCapability } = api();
    const original = structuredClone(initializeResult);
    assert.doesNotThrow(() => assertErrorCapability(initializeResult));
    assert.deepEqual(initializeResult, original);
  });
}

for (const [label, initializeResult] of [
  ["undefined result", undefined],
  ["null result", null],
  ["missing metadata", {}],
  ["missing errors capability", { _meta: {} }],
  [
    "capability nested under agentCapabilities",
    {
      agentCapabilities: {
        _meta: { "antnest.dev/errors": { version: 1 } },
      },
    },
  ],
  ["missing version", { _meta: { "antnest.dev/errors": {} } }],
  ["version zero", { _meta: { "antnest.dev/errors": { version: 0 } } }],
  ["future version", { _meta: { "antnest.dev/errors": { version: 2 } } }],
  ["string version", { _meta: { "antnest.dev/errors": { version: "1" } } }],
  ["boolean version", { _meta: { "antnest.dev/errors": { version: true } } }],
  ["null capability", { _meta: { "antnest.dev/errors": null } }],
  ["numeric capability", { _meta: { "antnest.dev/errors": 1 } }],
]) {
  test(`rejects ${label} instead of inferring error support`, () => {
    const { assertErrorCapability } = api();
    assert.throws(() => assertErrorCapability(initializeResult));
  });
}

for (const expected of criticalReceipts) {
  const expectedCode = expected.data.code;
  test(`generates the fixed ${expectedCode} receipt with only public fields`, () => {
    const { admissionErrorReceipt } = api();
    assert.deepEqual(admissionErrorReceipt(expectedCode), expected);
  });

  test(`accepts an independently constructed ${expectedCode} receipt`, () => {
    const { assertAdmissionError } = api();
    assert.doesNotThrow(() =>
      assertAdmissionError(structuredClone(expected), expectedCode),
    );
  });
}

test("every canonical admission definition has an exact generated and accepted receipt", () => {
  const { admissionErrorReceipt, assertAdmissionError } = api();
  assert(admissionDefinitions.length > 0);
  for (const [code] of admissionDefinitions) {
    const expected = canonicalReceipt(code);
    assert.deepEqual(admissionErrorReceipt(code), expected, code);
    assert.doesNotThrow(() => assertAdmissionError(expected, code), code);
  }
});

test("HTTP-only and Skill-source definitions cannot become admission receipts", () => {
  const { admissionErrorReceipt, assertAdmissionError } = api();
  const nonAdmission = definitions.filter(
    ([, entry]) => !entry.surfaces.includes("admission"),
  );
  assert(nonAdmission.length > 0);
  for (const [code] of nonAdmission) {
    assert.throws(() => admissionErrorReceipt(code), undefined, code);
    assert.throws(
      () => assertAdmissionError(canonicalReceipt(code), code),
      undefined,
      code,
    );
  }
});

test("accepts the canonical fields on an SDK-shaped Error instance", () => {
  const { assertAdmissionError } = api();
  const receipt = canonicalReceipt("agent_busy");
  const error = Object.assign(new Error(receipt.message), {
    name: "RequestError",
    code: receipt.code,
    data: receipt.data,
  });
  assert.doesNotThrow(() => assertAdmissionError(error, "agent_busy"));
});

for (const expectedCode of [
  "not_registered",
  "internal_error",
  "failed",
  "unresolved",
  "toString",
  "__proto__",
  "constructor",
  "",
]) {
  test(`rejects unregistered or non-admission expected code ${JSON.stringify(expectedCode)}`, () => {
    const { admissionErrorReceipt, assertAdmissionError } = api();
    assert.throws(() => admissionErrorReceipt(expectedCode));
    assert.throws(() =>
      assertAdmissionError(canonicalReceipt("agent_busy"), expectedCode),
    );
  });
}

test("rejects a null admission receipt", () => {
  const { assertAdmissionError } = api();
  assert.throws(() => assertAdmissionError(null, "agent_busy"));
});

const invalidBusyReceipts = [
  [
    "missing numeric code",
    (value) => {
      delete value.code;
    },
  ],
  [
    "string numeric code",
    (value) => {
      value.code = "-32030";
    },
  ],
  [
    "another numeric code",
    (value) => {
      value.code = -32031;
    },
  ],
  [
    "missing data",
    (value) => {
      delete value.data;
    },
  ],
  [
    "null data",
    (value) => {
      value.data = null;
    },
  ],
  [
    "missing semantic code",
    (value) => {
      delete value.data.code;
    },
  ],
  [
    "another semantic code",
    (value) => {
      value.data.code = "session_busy";
    },
  ],
  [
    "private message",
    (value) => {
      value.message = privateMessage;
    },
  ],
  [
    "missing message",
    (value) => {
      delete value.message;
    },
  ],
  [
    "false retryable",
    (value) => {
      value.data.retryable = false;
    },
  ],
  [
    "string retryable",
    (value) => {
      value.data.retryable = "true";
    },
  ],
  [
    "missing retryable",
    (value) => {
      delete value.data.retryable;
    },
  ],
  [
    "missing backoff delay",
    (value) => {
      delete value.data.retry_after_ms;
    },
  ],
  [
    "zero backoff delay",
    (value) => {
      value.data.retry_after_ms = 0;
    },
  ],
  [
    "another backoff delay",
    (value) => {
      value.data.retry_after_ms = 1001;
    },
  ],
  [
    "fractional backoff delay",
    (value) => {
      value.data.retry_after_ms = 1000.5;
    },
  ],
  [
    "string backoff delay",
    (value) => {
      value.data.retry_after_ms = "1000";
    },
  ],
  [
    "private cause in data",
    (value) => {
      value.data.cause = privateMessage;
    },
  ],
  [
    "credential details",
    (value) => {
      value.data.details = { credential: privateMessage };
    },
  ],
  [
    "unapproved data field",
    (value) => {
      value.data.automatic_retry = true;
    },
  ],
];

for (const [label, change] of invalidBusyReceipts) {
  test(`rejects ${label} on an otherwise canonical busy receipt`, () => {
    const { assertAdmissionError } = api();
    const actual = canonicalReceipt("agent_busy");
    change(actual);
    assert.throws(() => assertAdmissionError(actual, "agent_busy"));
  });
}

for (const expected of criticalReceipts) {
  test(`rejects legacy -32020 with typed ${expected.data.code}`, () => {
    const { assertAdmissionError } = api();
    assert.throws(() =>
      assertAdmissionError(
        { ...structuredClone(expected), code: -32020 },
        expected.data.code,
      ),
    );
  });
}

for (const expected of criticalReceipts.filter(
  (receipt) => !Object.hasOwn(receipt.data, "retry_after_ms"),
)) {
  for (const [label, delay] of [
    ["backoff", 1000],
    ["zero", 0],
    ["explicit undefined", undefined],
  ]) {
    test(`rejects an invented ${label} delay for ${expected.data.code}`, () => {
      const { assertAdmissionError } = api();
      const actual = structuredClone(expected);
      actual.data.retry_after_ms = delay;
      assert.throws(() => assertAdmissionError(actual, expected.data.code));
    });
  }
}

for (const [outcome, terminal] of Object.entries(catalog.terminal_outcomes)) {
  test(`does not accept the ${outcome} terminal numeric code as admission`, () => {
    const { assertAdmissionError } = api();
    const actual = canonicalReceipt("model_unavailable");
    actual.code = terminal.json_rpc_code;
    assert.throws(() => assertAdmissionError(actual, "model_unavailable"));
  });
}

test("the safe unknown fallback cannot satisfy a typed admission expectation", () => {
  const { assertAdmissionError } = api();
  const fallback = catalog.fallback;
  assert.throws(() =>
    assertAdmissionError(
      {
        code: fallback.json_rpc_code,
        message: fallback.message,
        data: { code: fallback.data_code, retryable: fallback.retryable },
      },
      "model_unavailable",
    ),
  );
});

test("only the five canonical backoff codes carry the exact default delay", () => {
  const { admissionErrorReceipt } = api();
  const delayedCodes = [];
  for (const [code] of admissionDefinitions) {
    const receipt = admissionErrorReceipt(code);
    if (backoffCodes.includes(code)) {
      assert.equal(Object.hasOwn(receipt.data, "retry_after_ms"), true, code);
      assert.equal(receipt.data.retry_after_ms, 1000, code);
      delayedCodes.push(code);
    } else {
      assert.equal(Object.hasOwn(receipt.data, "retry_after_ms"), false, code);
    }
  }
  assert.deepEqual(delayedCodes.sort(), [...backoffCodes].sort());
});

test("another valid canonical error does not satisfy the expected business rejection", () => {
  const { assertAdmissionError } = api();
  assert.throws(() =>
    assertAdmissionError(canonicalReceipt("session_busy"), "agent_busy"),
  );
});
