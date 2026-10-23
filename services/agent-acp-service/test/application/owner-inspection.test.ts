import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  OwnerIncarnationError,
  type OwnerRegistration,
} from "../../src/application/owner-incarnation.js";
import { parseOwnerInspection } from "../../src/application/owner-inspection.js";

const registrationId = "01234567-89ab-4cde-8fab-0123456789ab";
const incarnationId = "89abcdef-0123-4567-9abc-def012345678";
const receiptId = "fedcba98-7654-4321-abcd-0123456789ab";
const otherId = "76543210-fedc-4abc-bdef-0123456789ab";
const observedAt = "2026-10-23T12:34:56.123456700Z";
const privateValue = "PRIVATE_OWNER_INSPECTION_PAYLOAD";
type Wire = Record<string, unknown>;

function registration(): OwnerRegistration {
  return {
    registration_id: registrationId,
    member_id: "acp-a",
    incarnation_id: incarnationId,
  };
}

function receipt(overrides: Wire = {}): Wire {
  return {
    receipt_id: receiptId,
    reason: "container_stopped",
    observed_at: observedAt,
    ...overrides,
  };
}

function running(overrides: Wire = {}): Wire {
  return { state: "running", ...registration(), observed_at: observedAt, ...overrides };
}

function stopped(overrides: Wire = {}): Wire {
  return { state: "stopped", ...registration(), stop_receipt: receipt(), ...overrides };
}

function unknownInspection(overrides: Wire = {}): Wire {
  return {
    state: "unknown",
    registration_id: registrationId,
    reason: "unregistered",
    ...overrides,
  };
}

const variants: Array<[string, () => Wire]> = [
  ["running", running],
  ["stopped", stopped],
  ["unknown", unknownInspection],
];

function expectUnavailable(value: unknown, ...expected: [] | [unknown]): void {
  let failure: unknown;
  try {
    parseOwnerInspection(
      value,
      (expected.length === 0 ? registration() : expected[0]) as OwnerRegistration,
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OwnerIncarnationError);
  if (!(failure instanceof OwnerIncarnationError))
    throw new Error("Expected safe owner inspection rejection");
  expect(failure.name).toBe("OwnerIncarnationError");
  expect(failure.code).toBe("acp_registry_unavailable");
  expect(failure.message).toBe("acp_registry_unavailable");
  const rendered = `${inspect(failure, { depth: 12, showHidden: true })}\n${JSON.stringify(failure)}`;
  for (const secret of [privateValue, registrationId, incarnationId, receiptId, observedAt])
    expect(rendered).not.toContain(secret);
}

describe("parseOwnerInspection complete immutable wire", () => {
  it.each(variants)("retains the complete exact %s response as a frozen value", (_state, make) => {
    const expected = registration();
    const value = make();
    const before = structuredClone(value);
    const result = parseOwnerInspection(value, expected);
    expect(result).toStrictEqual(before);
    expect(value).toStrictEqual(before);
    expect(expected).toStrictEqual(registration());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, "state", "stopped")).toBe(false);
    expect(Reflect.set(result, "registration_id", otherId)).toBe(false);
    expect(Reflect.deleteProperty(result, "registration_id")).toBe(false);
    expect(result).toStrictEqual(before);
  });

  it("freezes the nested stop receipt while retaining its outer registration binding", () => {
    const stop = receipt();
    const value = stopped({ stop_receipt: stop });
    const before = structuredClone(value);
    const result = parseOwnerInspection(value, registration());
    expect(result).toStrictEqual(before);
    if (result.state !== "stopped") throw new Error("Expected the complete stopped response");
    expect(Object.isFrozen(result.stop_receipt)).toBe(true);
    expect(Reflect.set(result.stop_receipt, "receipt_id", otherId)).toBe(false);
    expect(Reflect.set(result.stop_receipt, "reason", "container_removed")).toBe(false);
    expect(Reflect.deleteProperty(result.stop_receipt, "observed_at")).toBe(false);
    // Either a copied value or frozen caller objects must prevent a mutable
    // alias from changing an already accepted binding or first receipt.
    Reflect.set(value, "member_id", "acp-b");
    Reflect.set(stop, "receipt_id", otherId);
    expect(result).toStrictEqual(before);
  });

  it.each(["container_stopped", "container_restarted", "container_removed"])(
    "retains the authenticated %s stop reason without detaching its receipt",
    (reason) => {
      const value = stopped({ stop_receipt: receipt({ reason }) });
      expect(parseOwnerInspection(value, registration())).toStrictEqual(value);
    },
  );

  it.each(["unregistered", "platform_unavailable", "engine_changed", "membership_unavailable"])(
    "retains unknown/%s without inventing a stop fact or member binding",
    (reason) => {
      const value = unknownInspection({ reason });
      const result = parseOwnerInspection(value, registration());
      expect(result).toStrictEqual(value);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.keys(result).sort()).toEqual(["reason", "registration_id", "state"]);
      expect(result).not.toHaveProperty("stop_receipt");
      expect(result).not.toHaveProperty("member_id");
      expect(result).not.toHaveProperty("incarnation_id");
      expect(result).not.toHaveProperty("observed_at");
    },
  );

  it.each(["a", "0", "acp-a", "a--b", "a".repeat(64)])(
    "accepts a canonical member identifier %s in the expected tuple and bound responses",
    (memberId) => {
      const expected = { ...registration(), member_id: memberId };
      for (const make of [running, stopped]) {
        const value = make({ member_id: memberId });
        expect(parseOwnerInspection(value, expected)).toStrictEqual(value);
      }
      expect(parseOwnerInspection(unknownInspection(), expected)).toStrictEqual(
        unknownInspection(),
      );
    },
  );

  it.each(["8", "9", "a", "b"])("accepts lowercase UUIDv4 variant %s", (variant) => {
    const id = `01234567-89ab-4cde-${variant}fab-0123456789ab`;
    const expected = { ...registration(), registration_id: id, incarnation_id: id };
    const value = stopped({ ...expected, stop_receipt: receipt({ receipt_id: id }) });
    expect(parseOwnerInspection(value, expected)).toStrictEqual(value);
  });
});

describe("parseOwnerInspection strict shapes and binding", () => {
  const invalidRoots: Array<[string, () => unknown]> = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["boolean", () => true],
    ["number", () => 200],
    ["string", () => privateValue],
    ["unparsed JSON", () => JSON.stringify(stopped())],
    ["empty object", () => ({})],
    ["array", () => []],
    ["array with wire properties", () => Object.assign([], running())],
    ["registration without inspection", registration],
    ["bare stop receipt", receipt],
    ["response envelope", () => ({ inspection: stopped() })],
    ["status code as stop proof", () => ({ status: 404, stopped: true })],
    [
      "registry failure as stop proof",
      () => ({ code: "acp_registry_unavailable", message: privateValue, retryable: true }),
    ],
  ];
  it.each(invalidRoots)("rejects %s with a safe registry error", (_name, make) => {
    expectUnavailable(make());
  });

  for (const [state, make] of variants) {
    it.each(Object.keys(make()))(`rejects %s missing from ${state}`, (field) => {
      const value = make();
      delete value[field];
      expectUnavailable(value);
    });

    it(`rejects extra string, hidden and symbol fields in ${state}`, () => {
      expectUnavailable({ ...make(), registration_nonce: privateValue });
      expectUnavailable({ ...make(), unused: undefined });
      expectUnavailable({ ...make(), [Symbol("private payload")]: privateValue });
      const hidden = make();
      Object.defineProperty(hidden, "private_payload", { value: privateValue });
      expectUnavailable(hidden);
    });

    it(`requires ${state} fields to be present on the actual wire object`, () => {
      const value = make();
      delete value.registration_id;
      const inherited: unknown = Object.assign(
        Object.create({ registration_id: registrationId }) as object,
        value,
      );
      expectUnavailable(inherited);
    });

    it.each(["", "Running", "STOPPED", "stopped ", "unavailable", "healthy", null, false, 0])(
      `rejects a wrong state %s in ${state}`,
      (invalid) => expectUnavailable({ ...make(), state: invalid }),
    );
  }

  it.each([
    ["registration_id", "registrationId"],
    ["member_id", "memberId"],
    ["incarnation_id", "incarnationId"],
    ["observed_at", "observedAt"],
  ] as const)("rejects running field alias %s/%s", (field, alias) => {
    const value = running();
    value[alias] = value[field];
    delete value[field];
    expectUnavailable(value);
  });

  it("rejects stopped receipt aliases and a nested binding in place of the outer binding", () => {
    const alias = stopped();
    alias.stopReceipt = alias.stop_receipt;
    delete alias.stop_receipt;
    expectUnavailable(alias);
    expectUnavailable({ state: "stopped", registration: registration(), stop_receipt: receipt() });
    expectUnavailable({ ...receipt(), state: "stopped" });
  });

  it.each(["registration_id", "member_id", "incarnation_id"])(
    "rejects a valid foreign %s even when a complete stop receipt is supplied",
    (field) => {
      const foreign = field === "member_id" ? "acp-b" : otherId;
      for (const make of [running, stopped]) expectUnavailable(make({ [field]: foreign }));
    },
  );

  it("rejects unknown for a different registration and all attempts to smuggle a stop binding into unknown", () => {
    expectUnavailable(unknownInspection({ registration_id: otherId }));
    for (const [field, value] of Object.entries({
      member_id: "acp-a",
      incarnation_id: incarnationId,
      observed_at: observedAt,
      stop_receipt: receipt(),
      stopped: true,
    }))
      expectUnavailable(unknownInspection({ [field]: value }));
  });

  it("rejects mixed state shapes rather than selecting the most positive-looking facts", () => {
    expectUnavailable(running({ stop_receipt: receipt() }));
    expectUnavailable(running({ reason: "engine_changed" }));
    expectUnavailable(stopped({ observed_at: observedAt }));
    expectUnavailable(stopped({ reason: "container_stopped" }));
    expectUnavailable(stopped({ stop_receipt: null }));
    expectUnavailable(stopped({ stop_receipt: [receipt()] }));
  });

  it.each([
    "container_stopped",
    "container_restarted",
    "container_removed",
    "",
    "platform-unavailable",
    "PLATFORM_UNAVAILABLE",
    null,
    false,
    0,
  ])("rejects unknown reason %s outside its four diagnostic reasons", (reason) =>
    expectUnavailable(unknownInspection({ reason })),
  );

  it.each([
    "unregistered",
    "platform_unavailable",
    "engine_changed",
    "membership_unavailable",
    "",
    "container-stopped",
    "CONTAINER_STOPPED",
    null,
    false,
    0,
  ])("rejects receipt reason %s outside its three positive stop facts", (reason) =>
    expectUnavailable(stopped({ stop_receipt: receipt({ reason }) })),
  );

  it.each(["receipt_id", "reason", "observed_at"])("rejects missing receipt field %s", (field) => {
    const stop = receipt();
    delete stop[field];
    expectUnavailable(stopped({ stop_receipt: stop }));
  });

  it("rejects extra receipt fields and camelCase receipt aliases", () => {
    for (const field of ["member_id", "incarnation_id", "registration_id", "registration_nonce"])
      expectUnavailable(stopped({ stop_receipt: receipt({ [field]: privateValue }) }));
    expectUnavailable(stopped({ stop_receipt: receipt({ extra: undefined }) }));
    expectUnavailable(
      stopped({ stop_receipt: receipt({ [Symbol("private receipt")]: privateValue }) }),
    );
    for (const [field, alias] of [
      ["receipt_id", "receiptId"],
      ["observed_at", "observedAt"],
    ] as const) {
      const stop = receipt();
      stop[alias] = stop[field];
      delete stop[field];
      expectUnavailable(stopped({ stop_receipt: stop }));
    }
  });
});

describe("parseOwnerInspection validates the expected registration before every state", () => {
  it.each([null, undefined, false, 1, privateValue, [], {}])(
    "rejects a non-registration expected value %s",
    (expected) => {
      for (const [, make] of variants) expectUnavailable(make(), expected);
    },
  );

  it.each(["registration_id", "member_id", "incarnation_id"])(
    "requires expected field %s",
    (field) => {
      const expected: Wire = { ...registration() };
      delete expected[field];
      for (const [, make] of variants) expectUnavailable(make(), expected);
    },
  );

  it("rejects expected extras, aliases and inherited required fields even for unknown", () => {
    for (const expected of [
      { ...registration(), registration_nonce: privateValue },
      { ...registration(), extra: undefined },
      { ...registration(), [Symbol("private expected")]: privateValue },
      { registrationId, memberId: "acp-a", incarnationId },
      Object.assign(Object.create({ member_id: "acp-a" }) as object, {
        registration_id: registrationId,
        incarnation_id: incarnationId,
      }),
    ])
      for (const [, make] of variants) expectUnavailable(make(), expected);
  });

  const invalidUuids: unknown[] = [
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
    registrationId.toUpperCase(),
    registrationId.replace("-4cde-", "-1cde-"),
    registrationId.replace("-8fab-", "-7fab-"),
    registrationId.replaceAll("-", ""),
    ` ${registrationId}`,
    `${registrationId}\n`,
    `${registrationId}\r`,
    `${registrationId}\u2028`,
    `${registrationId}\u2029`,
    null,
    undefined,
    0,
    false,
    [],
    {},
  ];

  for (const field of ["registration_id", "incarnation_id"] as const) {
    it.each(invalidUuids.map((value, index) => [index, value] as const))(
      `rejects malformed expected and wire ${field} case %s`,
      (_index, invalid) => {
        const expected = { ...registration(), [field]: invalid };
        for (const [, make] of variants) expectUnavailable(make(), expected);
        for (const make of [running, stopped])
          expectUnavailable(make({ [field]: invalid }), expected);
        if (field === "registration_id")
          expectUnavailable(unknownInspection({ registration_id: invalid }), expected);
      },
    );
  }

  it.each(invalidUuids.map((value, index) => [index, value] as const))(
    "rejects malformed receipt UUID case %s",
    (_index, invalid) =>
      expectUnavailable(stopped({ stop_receipt: receipt({ receipt_id: invalid }) })),
  );

  it.each(
    [
      "",
      "Acp-a",
      "-acp",
      "acp-",
      "acp_a",
      "acp.a",
      "a/b",
      "a".repeat(65),
      " acp-a",
      "acp-a\n",
      "acp-a\r",
      "acp-a\u2028",
      "acp-a\u2029",
      null,
      undefined,
      0,
      false,
      [],
      {},
    ].map((value, index) => [index, value] as const),
  )("rejects malformed expected and wire member case %s", (_index, memberId) => {
    const expected = { ...registration(), member_id: memberId };
    for (const [, make] of variants) expectUnavailable(make(), expected);
    for (const make of [running, stopped])
      expectUnavailable(make({ member_id: memberId }), expected);
  });
});

describe("parseOwnerInspection UTC calendar timestamps are diagnostics", () => {
  const validTimes = [
    "0001-01-01T00:00:00Z",
    "1900-02-28T23:59:59Z",
    "2000-02-29T12:34:56Z",
    "2024-02-29T23:59:59Z",
    "9999-12-31T23:59:59Z",
    ...Array.from(
      { length: 9 },
      (_, index) => `2026-10-23T12:34:56.${"123456789".slice(0, index + 1)}Z`,
    ),
    "2026-10-23T12:34:56.000000000Z",
    observedAt,
  ];
  const invalidTimes: unknown[] = [
    "2023-02-29T12:34:56Z",
    "1900-02-29T12:34:56Z",
    "2100-02-29T12:34:56Z",
    "2024-02-30T12:34:56Z",
    "2026-04-31T12:34:56Z",
    "2026-06-31T12:34:56Z",
    "2026-00-23T12:34:56Z",
    "2026-13-23T12:34:56Z",
    "2026-10-00T12:34:56Z",
    "2026-10-32T12:34:56Z",
    "2026-10-23T24:00:00Z",
    "2026-10-23T12:60:00Z",
    "2026-10-23T12:34:60Z",
    "2026-10-23T-1:34:56Z",
    "2026-10-23T1:34:56Z",
    "2026-1-23T12:34:56Z",
    "2026-10-3T12:34:56Z",
    "2026-10-23 12:34:56Z",
    "2026-10-23t12:34:56Z",
    "2026-10-23T12:34:56z",
    "2026-10-23T12:34:56",
    "2026-10-23T12:34:56+00:00",
    "2026-10-23T12:34:56-00:00",
    "2026-10-23T12:34:56+08:00",
    "2026-10-23T12:34:56.Z",
    "2026-10-23T12:34:56.1234567890Z",
    "2026-10-23T12:34:56,1Z",
    ` ${observedAt}`,
    `${observedAt} `,
    `${observedAt}\n`,
    `${observedAt}\r`,
    `${observedAt}\u2028`,
    `${observedAt}\u2029`,
    "",
    privateValue,
    null,
    undefined,
    0,
    false,
    new Date(observedAt),
    [],
    {},
  ];
  for (const state of ["running", "stopped"] as const) {
    const withTime = (value: unknown): Wire =>
      state === "running"
        ? running({ observed_at: value })
        : stopped({ stop_receipt: receipt({ observed_at: value }) });

    it.each(validTimes)(
      `retains ${state} UTC %s verbatim without applying a freshness or age rule`,
      (at) => {
        const value = withTime(at);
        expect(parseOwnerInspection(value, registration())).toStrictEqual(value);
      },
    );

    it.each(invalidTimes.map((value, index) => [index, value] as const))(
      `rejects malformed or impossible ${state} UTC time case %s`,
      (_index, at) => expectUnavailable(withTime(at)),
    );
  }
});

describe("parseOwnerInspection never discloses rejected values or thrown input errors", () => {
  it("normalizes a throwing response accessor without retaining its private cause", () => {
    const value = running();
    Object.defineProperty(value, "observed_at", {
      enumerable: true,
      get() {
        throw new Error(privateValue);
      },
    });
    expectUnavailable(value);
  });

  it("normalizes a throwing expected accessor even for a valid unknown response", () => {
    const expected = registration();
    Object.defineProperty(expected, "member_id", {
      enumerable: true,
      get() {
        throw new Error(privateValue);
      },
    });
    expectUnavailable(unknownInspection(), expected);
  });

  it("normalizes response and expected property-enumeration failures", () => {
    const response = new Proxy(stopped(), {
      ownKeys() {
        throw new Error(privateValue);
      },
    });
    const expected = new Proxy(registration(), {
      ownKeys() {
        throw new Error(privateValue);
      },
    });
    expectUnavailable(response);
    expectUnavailable(unknownInspection(), expected);
  });
});
