import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  auditCursor,
  auditDetailSchema,
  auditEventsSchema,
  auditListSchema,
  getAuditSchema,
  listAuditEventsSchema,
  listAuditsSchema,
  readAuditCursor,
} from "../../src/domain/execution-audit.js";

function validator(name: string) {
  const schema: unknown = JSON.parse(
    readFileSync(
      new URL(`../../../../contracts/agent-acp/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new Error("Invalid schema");
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addSchema(
    JSON.parse(
      readFileSync(
        new URL("../../../../contracts/common/pagination.schema.json", import.meta.url),
        "utf8",
      ),
    ) as object,
  );
  return ajv.compile(schema);
}

describe("administrative audit shared contract", () => {
  it.each([
    [
      "list-execution-audits-request",
      listAuditsSchema,
      [{}, { limit: 100 }, { agent_id: "a", created_from: "2026-09-14T00:00:00.123456Z" }],
      [{ organization_id: "org" }, { limit: 101 }, { cursor: "" }, { created_from: "yesterday" }],
    ],
    [
      "get-execution-audit-request",
      getAuditSchema,
      [{ run_id: "r" }],
      [{}, { run_id: "r", admin: true }],
    ],
    [
      "list-execution-events-request",
      listAuditEventsSchema,
      [{ run_id: "r" }, { run_id: "r", stream: "permissions" }],
      [
        { run_id: "r", stream: "all" },
        { run_id: "r", organization_id: "other" },
      ],
    ],
  ] as const)("matches structural validation for %s", (name, schema, allowed, rejected) => {
    const shared = validator(name);
    for (const value of allowed) {
      expect(shared(value)).toBe(true);
      expect(schema.safeParse(value).success).toBe(true);
    }
    for (const value of rejected) {
      expect(shared(value)).toBe(false);
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("keeps summary and event responses bounded to their documented shapes", () => {
    const list = { items: [], next_cursor: null };
    expect(auditListSchema.safeParse(list).success).toBe(true);
    expect(validator("execution-audit-list")(list)).toBe(true);
    const events = { stream: "execution", items: [], next_cursor: null };
    expect(auditEventsSchema.safeParse(events).success).toBe(true);
    expect(validator("execution-audit-events")(events)).toBe(true);
    expect(validator("execution-audit-events")({ ...events, credential: "forbidden" })).toBe(false);
  });

  it("retains failed triggers while excluding top-level credential material", () => {
    const detail = {
      run_id: "r",
      session_id: "s",
      agent_id: "a",
      principal_id: "p",
      state: "failed",
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:00Z",
      input: [{ type: "text", text: "failed trigger" }],
      execution_snapshot: null,
      terminal_class: null,
      executor_state: null,
      tool_effect_state: null,
      stop_reason: null,
      error_class: "provider_unavailable",
      usage_measurements: [],
    };
    expect(auditDetailSchema.safeParse(detail).success).toBe(true);
    expect(validator("execution-audit")(detail)).toBe(true);
    expect(validator("execution-audit")({ ...detail, credential: "secret" })).toBe(false);
  });
});

it("preserves exact optional budget facts in the shared audit contract", () => {
  const legacy = {
    run_id: "r",
    session_id: "s",
    agent_id: "a",
    principal_id: "p",
    state: "failed",
    created_at: "2026-09-14T00:00:00Z",
    updated_at: "2026-09-14T00:00:00Z",
    input: [],
    execution_snapshot: null,
    terminal_class: null,
    executor_state: null,
    tool_effect_state: null,
    stop_reason: null,
    error_class: "budget_exceeded",
    usage_measurements: [],
  };
  const shared = validator("execution-audit");
  const facts = [
    { scope: "run_cost", limit: "10", used: "90071992547409910001" },
    { scope: "unknown_cost", limit: null, used: null },
  ];
  for (const value of [legacy, ...facts.map((budget_reason) => ({ ...legacy, budget_reason }))]) {
    expect(shared(value), JSON.stringify(shared.errors)).toBe(true);
    expect(auditDetailSchema.safeParse(value).success).toBe(true);
  }
  for (const budget_reason of [
    null,
    {},
    { ...facts[0], used: "2\n" },
    { ...facts[0], used: "01" },
    { ...facts[0], limit: 10 },
    { ...facts[0], secret: "private" },
    { ...facts[0], scope: "private" },
  ]) {
    const value = { ...legacy, budget_reason };
    expect(shared(value)).toBe(false);
    expect(auditDetailSchema.safeParse(value).success).toBe(false);
  }
});

describe("contract conventions", () => {
  const oversizedUnicode = "ü".repeat(2049);

  it.each([
    ["allows a 4096-byte audit cursor", { limit: 10, cursor: "x".repeat(4096) }, true],
    ["rejects an empty audit cursor", { limit: 10, cursor: "" }, false],
    ["rejects a 4097-byte audit cursor", { limit: 10, cursor: "x".repeat(4097) }, false],
    ["rejects a cursor over 4096 UTF-8 bytes", { limit: 10, cursor: oversizedUnicode }, false],
  ])("%s", (_name, value, allowed) => {
    expect(listAuditsSchema.safeParse(value).success).toBe(allowed);
    expect(listAuditEventsSchema.safeParse({ ...value, run_id: "run-1" }).success).toBe(allowed);
  });

  it.each([
    ["null continuation", { items: [], next_cursor: null }, true],
    ["opaque continuation", { items: [], next_cursor: "cursor-token" }, true],
    ["empty continuation", { items: [], next_cursor: "" }, false],
    ["4097-byte continuation", { items: [], next_cursor: "x".repeat(4097) }, false],
  ])("auditList %s", (_name, value, allowed) => {
    expect(auditListSchema.safeParse(value).success).toBe(allowed);
  });

  it("readAuditCursor rejects an overlong token before decoding", () => {
    const scope = "list-audits";
    const position = { kind: "sequence", sequence: 1 } as const;
    const valid = auditCursor(scope, position);
    expect(readAuditCursor(valid, scope)).toEqual(position);
    const wideScope = "s".repeat(4096);
    const oversized = auditCursor(wideScope, position);
    expect(() => readAuditCursor(oversized, wideScope)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
  });
});
