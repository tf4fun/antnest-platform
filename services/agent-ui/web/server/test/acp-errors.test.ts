import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";

type Definition = {
  json_rpc_code: number | null;
  message: string;
  retryable: boolean;
  recovery: string;
  retry_after_ms?: number;
  surfaces: string[];
};
type Catalog = {
  capability: { name: string; version: number };
  errors: Record<string, Definition>;
  fallback: {
    json_rpc_code: number;
    data_code: string;
    message: string;
    retryable: false;
    recovery: string;
  };
  terminal_outcomes: Record<
    "failed" | "unresolved",
    {
      json_rpc_code: number;
      message: string;
      retryable: false;
    }
  >;
};
type Classification = {
  kind: "admission" | "terminal" | "unknown";
  code: string;
  message: string;
  retryable: boolean;
  retryDirective: string;
  retryAfterMs?: number;
  // A Prompt/Run outcome marker. Session/load callers do not infer a Run exists.
  requiresRunQuery: boolean;
};
type API = {
  readAcpErrorCapability(meta: unknown): 1 | null;
  classifyAcpError(cause: unknown, capability: 1 | null): Classification;
};

const catalog = JSON.parse(
  readFileSync(
    new URL("../../../../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  ),
) as Catalog;
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../contracts/agent-acp/errors.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { $defs: { retryAfterMs: { minimum: number; maximum: number } } };
const delayBounds = schema.$defs.retryAfterMs;
const url = new URL("../src/adapters/acp-errors.ts", import.meta.url);
const implementation = (await import(url.href).catch((error: unknown) => {
  const missing = error as { code?: string; url?: string };
  if (missing.code === "ERR_MODULE_NOT_FOUND" && missing.url === url.href)
    return {};
  throw error;
})) as Partial<API>;

function capability(meta: unknown): 1 | null {
  const read = implementation.readAcpErrorCapability;
  assert.equal(typeof read, "function", "readAcpErrorCapability is required");
  return read!(meta);
}

function classify(cause: unknown, supported: 1 | null = 1): Classification {
  const read = implementation.classifyAcpError;
  assert.equal(typeof read, "function", "classifyAcpError is required");
  return read!(cause, supported);
}

function data(code: string): Record<string, unknown> {
  const entry = catalog.errors[code]!;
  return {
    code,
    retryable: entry.retryable,
    ...(entry.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: entry.retry_after_ms }),
  };
}

function receipt(
  code: string,
  overrides: Record<string, unknown> = {},
): RequestError {
  const entry = catalog.errors[code]!;
  assert.notEqual(entry.json_rpc_code, null);
  return new RequestError(entry.json_rpc_code!, entry.message, {
    ...data(code),
    ...overrides,
  });
}

function unknown(): Classification {
  return {
    kind: "unknown",
    code: catalog.fallback.data_code,
    message: catalog.fallback.message,
    retryable: false,
    retryDirective: catalog.fallback.recovery,
    requiresRunQuery: true,
  };
}

test("ACP errors capability reads only the producer's explicit supported metadata", () => {
  const meta = {
    [catalog.capability.name]: { version: catalog.capability.version },
    "antnest.dev/bridge": { intentReceipt: 1 },
  };
  const before = structuredClone(meta);
  assert.equal(capability(meta), 1);
  assert.deepEqual(meta, before);
});

for (const [name, meta] of [
  ["missing metadata", undefined],
  ["null metadata", null],
  ["non-object metadata", "antnest.dev/errors"],
  ["array metadata", []],
  ["another capability", { "antnest.dev/bridge": { intentReceipt: 1 } }],
  ["missing version", { "antnest.dev/errors": {} }],
  ["null declaration", { "antnest.dev/errors": null }],
  ["array declaration", { "antnest.dev/errors": [] }],
  ["boolean declaration", { "antnest.dev/errors": true }],
  ["older version", { "antnest.dev/errors": { version: 0 } }],
  ["unknown version", { "antnest.dev/errors": { version: 2 } }],
  ["string version", { "antnest.dev/errors": { version: "1" } }],
  [
    "nested initialize result rather than metadata",
    { _meta: { "antnest.dev/errors": { version: 1 } } },
  ],
] as const) {
  test("ACP error policy is unavailable for " + name, () => {
    const supported = capability(meta);
    assert.equal(supported, null);
    const result = classify(receipt("agent_busy"), supported);
    assert.deepEqual(result, unknown());
    assert.equal(Object.hasOwn(result, "retryAfterMs"), false);
  });
}

for (const [code, entry] of Object.entries(catalog.errors).filter(([, value]) =>
  value.surfaces.includes("admission"),
)) {
  test("ACP canonical admission policy preserves " + code, () => {
    const actual = receipt(code);
    const before = {
      code: actual.code,
      message: actual.message,
      data: structuredClone(actual.data),
    };
    assert.deepEqual(classify(actual), {
      kind: "admission",
      code,
      message: entry.message,
      retryable: entry.retryable,
      retryDirective: entry.recovery,
      ...(entry.retry_after_ms === undefined
        ? {}
        : { retryAfterMs: entry.retry_after_ms }),
      requiresRunQuery: entry.recovery === "query_intent",
    });
    assert.deepEqual(
      {
        code: actual.code,
        message: actual.message,
        data: actual.data,
      },
      before,
      "classification changed the service receipt",
    );
  });
}

test("retryable availability responses retain different recovery prerequisites", () => {
  const codes = [
    "agent_busy",
    "agent_unavailable",
    "runtime_barrier_required",
    "service_stopping",
  ];
  assert.deepEqual(
    codes.map((code) => classify(receipt(code)).retryDirective),
    ["backoff", "wait_binding", "wait_rebuild", "reconnect"],
  );
  for (const code of codes.slice(1)) {
    const result = classify(receipt(code));
    assert.equal(result.retryable, true);
    assert.equal(Object.hasOwn(result, "retryAfterMs"), false);
  }
});

for (const delay of new Set([
  delayBounds.minimum,
  catalog.errors.agent_busy!.retry_after_ms!,
  delayBounds.maximum,
])) {
  test(
    "backoff accepts a service delay permitted by the shared schema: " + delay,
    () => {
      const result = classify(receipt("agent_busy", { retry_after_ms: delay }));
      assert.equal(result.kind, "admission");
      assert.equal(result.retryDirective, "backoff");
      assert.equal(result.retryable, true);
      assert.equal(result.retryAfterMs, delay);
    },
  );
}

test("a missing service backoff delay is never synthesized from the catalog default", () => {
  const entry = catalog.errors.agent_busy!;
  const result = classify(
    new RequestError(entry.json_rpc_code!, entry.message, {
      code: "agent_busy",
      retryable: true,
    }),
  );
  assert.equal(result.kind, "admission");
  assert.equal(result.retryDirective, "backoff");
  assert.equal(result.retryable, true);
  assert.equal(Object.hasOwn(result, "retryAfterMs"), false);
});

for (const [name, delay] of [
  ["below the shared minimum", delayBounds.minimum - 1],
  ["above the shared maximum", delayBounds.maximum + 1],
  ["fractional", delayBounds.minimum + 0.5],
  ["string", String(delayBounds.minimum)],
  ["null", null],
  ["undefined", undefined],
  ["not finite", Number.POSITIVE_INFINITY],
  ["NaN", Number.NaN],
] as const) {
  test("invalid service backoff delay fails closed: " + name, () => {
    const result = classify(receipt("agent_busy", { retry_after_ms: delay }));
    assert.deepEqual(result, unknown());
    assert.equal(Object.hasOwn(result, "retryAfterMs"), false);
  });
}

for (const code of [
  "access_denied",
  "model_unavailable",
  "runtime_barrier_required",
  "agent_unavailable",
  "service_stopping",
]) {
  test("a delay cannot turn " + code + " into backoff replay", () => {
    assert.deepEqual(
      classify(
        receipt(code, {
          retry_after_ms: delayBounds.minimum,
        }),
      ),
      unknown(),
    );
  });
}

test("optional empty details do not change a canonical policy", () => {
  assert.deepEqual(
    classify(receipt("agent_busy", { details: {} })),
    classify(receipt("agent_busy")),
  );
});

const canary = "PRIVATE-ACP-CAUSE-CANARY";
const busy = catalog.errors.agent_busy!;
for (const [name, cause] of [
  ["transport rejection", new Error(canary)],
  ["missing error", undefined],
  [
    "numeric code without service data",
    new RequestError(busy.json_rpc_code!, busy.message),
  ],
  ["message without service classification", new Error(busy.message)],
  [
    "old generic numeric code with a busy string",
    new RequestError(-32020, busy.message, data("agent_busy")),
  ],
  [
    "wrong numeric class",
    new RequestError(-32603, busy.message, data("agent_busy")),
  ],
  ["null data", new RequestError(busy.json_rpc_code!, busy.message, null)],
  ["array data", new RequestError(busy.json_rpc_code!, busy.message, [])],
  [
    "missing string code",
    new RequestError(busy.json_rpc_code!, busy.message, { retryable: true }),
  ],
  [
    "missing retryable",
    new RequestError(busy.json_rpc_code!, busy.message, { code: "agent_busy" }),
  ],
  ["unregistered code", receipt("agent_busy", { code: canary })],
  ["numeric data code", receipt("agent_busy", { code: busy.json_rpc_code })],
  ["wrong retryable value", receipt("agent_busy", { retryable: false })],
  ["nonboolean retryable", receipt("agent_busy", { retryable: "true" })],
  [
    "noncanonical public message",
    new RequestError(busy.json_rpc_code!, canary, data("agent_busy")),
  ],
  ["unapproved details", receipt("agent_busy", { details: { cause: canary } })],
  ["array details", receipt("agent_busy", { details: [] })],
  ["null details", receipt("agent_busy", { details: null })],
  ["additional private data", receipt("agent_busy", { secret: canary })],
  [
    "plain object imitating a service error",
    {
      code: busy.json_rpc_code,
      message: busy.message,
      data: data("agent_busy"),
    },
  ],
  [
    "local exception imitating a service error",
    Object.assign(new Error(busy.message), {
      code: busy.json_rpc_code,
      data: data("agent_busy"),
    }),
  ],
] as const) {
  test(
    "untrusted or malformed Prompt failure requires reconciliation: " + name,
    () => {
      const result = classify(cause);
      assert.deepEqual(result, unknown());
      assert.equal(result.requiresRunQuery, true);
      assert(
        !JSON.stringify(result).includes(canary),
        "private error text escaped classification",
      );
    },
  );
}

test("the catalog fallback cannot become automatic Prompt replay", () => {
  const fallback = catalog.fallback;
  assert.deepEqual(
    classify(
      new RequestError(fallback.json_rpc_code, fallback.message, {
        code: fallback.data_code,
        retryable: fallback.retryable,
      }),
    ),
    unknown(),
  );
});

for (const [outcome, terminal] of Object.entries(catalog.terminal_outcomes)) {
  for (const code of [
    "model_unsupported_content",
    "future_run_failure",
    "agent_busy",
  ]) {
    test(
      "terminal " +
        outcome +
        " with " +
        code +
        " queries the original Run instead of admission replay",
      () => {
        const cause = new RequestError(
          terminal.json_rpc_code,
          terminal.message,
          {
            code,
            retryable: false,
          },
        );
        assert.deepEqual(classify(cause), {
          kind: "terminal",
          code,
          message: terminal.message,
          retryable: false,
          retryDirective: "none",
          requiresRunQuery: true,
        });
        const unsupported = classify(cause, null);
        assert.equal(unsupported.retryable, false);
        assert.equal(unsupported.requiresRunQuery, true);
        assert.equal(Object.hasOwn(unsupported, "retryAfterMs"), false);
      },
    );
  }
  for (const [name, overrides] of [
    ["retryable claim", { retryable: true }],
    ["backoff claim", { retry_after_ms: delayBounds.minimum }],
    ["missing failure classification", { code: "" }],
    ["private failure text", { code: canary }],
  ] as const) {
    test(
      "malformed terminal " + outcome + " remains nonreplayable: " + name,
      () => {
        const result = classify(
          new RequestError(terminal.json_rpc_code, terminal.message, {
            code: "model_unsupported_content",
            retryable: false,
            ...overrides,
          }),
        );
        assert.deepEqual(result, unknown());
        assert.equal(result.requiresRunQuery, true);
        assert(!JSON.stringify(result).includes(canary));
      },
    );
  }
}
