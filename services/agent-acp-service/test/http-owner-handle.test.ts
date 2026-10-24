import { describe, expect, it, vi } from "vitest";
import { HttpOwnerHandles } from "../src/application/http-owner-handle.js";
import type { OwnerRegistration } from "../src/application/owner-incarnation.js";
import { SecretBox } from "../src/adapters/postgres/secret-box.js";
import { DomainError } from "../src/domain/errors.js";

const associatedData = "antnest:acp:http-owner-handle:v1";
const membershipSha256 = "a".repeat(64);
const key = Buffer.alloc(32, 7);
const privateMarker = "PRIVATE_HTTP_OWNER_HANDLE_VALUE";

function input() {
  const owner: OwnerRegistration = {
    registration_id: "11111111-1111-4111-8111-111111111111",
    member_id: "acp-a",
    incarnation_id: "22222222-2222-4222-9222-222222222222",
  };
  return {
    owner,
    epoch: "7",
    connectionId: "private-sdk-connection-id",
    identity: {
      organizationId: "private-organization-id",
      principalId: "private-principal-id",
      agentId: "private-agent-id",
    },
  };
}

type Input = ReturnType<typeof input>;
type InvalidInput = [string, (value: Input) => unknown];

function plaintext(value = input()) {
  return {
    version: 1 as const,
    membership_sha256: membershipSha256,
    ...value,
    protocol: "v1" as const,
    transport: "http" as const,
  };
}

function handles(sharedKey = key, sha = membershipSha256) {
  return new HttpOwnerHandles({
    secretBox: new SecretBox(Buffer.from(sharedKey)),
    membershipSha256: sha,
  });
}

function authenticated(value: unknown, aad = associatedData): string {
  const sealed = new SecretBox(Buffer.from(key)).seal(value, aad);
  return `acph1.${sealed.nonce.toString("base64url")}.${sealed.ciphertext.toString("base64url")}`;
}

function authenticatedInput(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return authenticated(value);
  return authenticated({
    version: 1,
    membership_sha256: membershipSha256,
    ...value,
    protocol: "v1",
    transport: "http",
  });
}

function without(value: object, field: string): unknown {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
}

function invalidFailure(operation: () => unknown): DomainError {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DomainError);
  if (!(failure instanceof DomainError)) throw new Error("Expected a safe handle error");
  expect(failure.code).toBe("invalid_request");
  return failure;
}

function expectInvalid(operation: () => unknown, extraPrivateValues: readonly string[] = []): void {
  const failure = invalidFailure(operation);
  const baseline = invalidFailure(() => handles().open("invalid-http-owner-handle"));
  expect(failure.message).toBe(baseline.message);
  expect(Reflect.get(failure, "cause")).toBeUndefined();
  const exposed = [failure.message, failure.stack ?? "", JSON.stringify(failure)].join("\n");
  const original = input();
  for (const value of [
    privateMarker,
    key.toString("hex"),
    original.connectionId,
    ...Object.values(original.owner),
    ...Object.values(original.identity),
    ...extraPrivateValues,
  ])
    if (value.length > 0) expect(exposed).not.toContain(value);
}

const invalidInputs: InvalidInput[] = [
  ["null input", () => null],
  ["array input", () => []],
  ["string input", () => privateMarker],
  ["unknown field", (value) => ({ ...value, destination: privateMarker })],
  ["missing owner", (value) => without(value, "owner")],
  ["null owner", (value) => ({ ...value, owner: null })],
  [
    "unknown owner field",
    (value) => ({ ...value, owner: { ...value.owner, nonce: privateMarker } }),
  ],
  [
    "missing registration",
    (value) => ({ ...value, owner: without(value.owner, "registration_id") }),
  ],
  [
    "invalid registration",
    (value) => ({ ...value, owner: { ...value.owner, registration_id: privateMarker } }),
  ],
  [
    "uppercase registration",
    (value) => ({
      ...value,
      owner: { ...value.owner, registration_id: "ABCDEF01-2345-4ABC-8ABC-1234567890AB" },
    }),
  ],
  [
    "wrong registration version",
    (value) => ({
      ...value,
      owner: {
        ...value.owner,
        registration_id: value.owner.registration_id.replace("-4111-", "-1111-"),
      },
    }),
  ],
  [
    "wrong registration variant",
    (value) => ({
      ...value,
      owner: {
        ...value.owner,
        registration_id: value.owner.registration_id.replace("-8111-", "-7111-"),
      },
    }),
  ],
  ["missing incarnation", (value) => ({ ...value, owner: without(value.owner, "incarnation_id") })],
  [
    "invalid incarnation",
    (value) => ({ ...value, owner: { ...value.owner, incarnation_id: privateMarker } }),
  ],
  ["missing member", (value) => ({ ...value, owner: without(value.owner, "member_id") })],
  ["empty member", (value) => ({ ...value, owner: { ...value.owner, member_id: "" } })],
  [
    "overlong member",
    (value) => ({ ...value, owner: { ...value.owner, member_id: "a".repeat(65) } }),
  ],
  ["invalid member", (value) => ({ ...value, owner: { ...value.owner, member_id: "ACP-A" } })],
  ["missing epoch", (value) => without(value, "epoch")],
  ["zero epoch", (value) => ({ ...value, epoch: "0" })],
  ["negative epoch", (value) => ({ ...value, epoch: "-7" })],
  ["noncanonical epoch", (value) => ({ ...value, epoch: "07" })],
  ["numeric epoch", (value) => ({ ...value, epoch: 7 })],
  ["overflow epoch", (value) => ({ ...value, epoch: "9223372036854775808" })],
  ["missing connection ID", (value) => without(value, "connectionId")],
  ["empty connection ID", (value) => ({ ...value, connectionId: "" })],
  ["overlong connection ID", (value) => ({ ...value, connectionId: "c".repeat(201) })],
  ["untrimmed connection ID", (value) => ({ ...value, connectionId: ` ${value.connectionId}` })],
  ["null connection ID", (value) => ({ ...value, connectionId: null })],
  ["missing identity", (value) => without(value, "identity")],
  ["null identity", (value) => ({ ...value, identity: null })],
  [
    "unknown identity field",
    (value) => ({ ...value, identity: { ...value.identity, cct: privateMarker } }),
  ],
  ...(["organizationId", "principalId", "agentId"] as const).flatMap<InvalidInput>((field) => [
    [`missing ${field}`, (value) => ({ ...value, identity: without(value.identity, field) })],
    [`empty ${field}`, (value) => ({ ...value, identity: { ...value.identity, [field]: "" } })],
    [
      `overlong ${field}`,
      (value) => ({ ...value, identity: { ...value.identity, [field]: "i".repeat(201) } }),
    ],
    [
      `untrimmed ${field}`,
      (value) => ({
        ...value,
        identity: { ...value.identity, [field]: ` ${value.identity[field]}` },
      }),
    ],
  ]),
];

describe("HTTP original-owner opaque handles", () => {
  it("round trips between replicas sharing a key and membership and uses the fixed AES-GCM context", () => {
    const writer = handles();
    const reader = handles(Buffer.from(key));
    const original = input();
    const expected = plaintext(structuredClone(original));
    const value = writer.seal(original);
    expect(value).toMatch(/^acph1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(4096);
    const [, nonce, ciphertext] = value.split(".");
    const sealed = {
      nonce: Buffer.from(nonce!, "base64url"),
      ciphertext: Buffer.from(ciphertext!, "base64url"),
    };
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.length).toBeGreaterThan(16);
    expect(sealed.nonce.toString("base64url")).toBe(nonce);
    expect(sealed.ciphertext.toString("base64url")).toBe(ciphertext);
    expect(new SecretBox(Buffer.from(key)).open(sealed, associatedData)).toEqual(expected);
    Reflect.set(original.owner, "member_id", "acp-mutated");
    Reflect.set(original.identity, "agentId", "mutated-agent");
    Reflect.set(original, "connectionId", "mutated-sdk-id");
    expect(reader.open(value)).toEqual(expected);
    expect(writer.open(reader.seal(input()))).toEqual(plaintext());
    for (const privateValue of [expected.connectionId, ...Object.values(expected.identity)])
      expect(value).not.toContain(privateValue);
  });

  it("accepts the canonical upper epoch and identity length boundaries", () => {
    const value = input();
    value.epoch = "9223372036854775807";
    value.owner.member_id = "a".repeat(64);
    value.connectionId = "c".repeat(200);
    value.identity = {
      organizationId: "o".repeat(200),
      principalId: "p".repeat(200),
      agentId: "a".repeat(200),
    };
    const encoded = handles().seal(value);
    expect(encoded.length).toBeLessThanOrEqual(4096);
    expect(handles().open(encoded)).toEqual(plaintext(value));
  });

  it("rejects a different encryption key, pinned membership or associated-data context", () => {
    const value = handles().seal(input());
    expectInvalid(() => handles(Buffer.alloc(32, 8)).open(value), [value]);
    expectInvalid(() => handles(key, "b".repeat(64)).open(value), [value]);
    const otherContext = authenticated(plaintext(), associatedData + ":other");
    expectInvalid(() => handles().open(otherContext), [otherContext]);
  });

  it("rejects independent nonce, encrypted payload and authentication-tag changes", () => {
    const value = handles().seal(input());
    const [, nonce, ciphertext] = value.split(".");
    const originalNonce = Buffer.from(nonce!, "base64url");
    const originalCiphertext = Buffer.from(ciphertext!, "base64url");
    const changedNonce = Buffer.from(originalNonce);
    changedNonce[0] = changedNonce[0]! ^ 1;
    const changedPayload = Buffer.from(originalCiphertext);
    changedPayload[0] = changedPayload[0]! ^ 1;
    const changedTag = Buffer.from(originalCiphertext);
    changedTag[changedTag.length - 1] = changedTag[changedTag.length - 1]! ^ 1;
    for (const candidate of [
      `acph1.${changedNonce.toString("base64url")}.${ciphertext!}`,
      `acph1.${nonce!}.${changedPayload.toString("base64url")}`,
      `acph1.${nonce!}.${changedTag.toString("base64url")}`,
    ])
      expectInvalid(() => handles().open(candidate), [candidate, value]);
  });

  it("rejects malformed, padded, non-ASCII and oversized wire values before decryption", () => {
    const box = new SecretBox(Buffer.from(key));
    const reader = new HttpOwnerHandles({ secretBox: box, membershipSha256 });
    const value = reader.seal(input());
    const [, nonce, ciphertext] = value.split(".");
    const decrypt = vi.spyOn(box, "open");
    try {
      for (const candidate of [
        undefined,
        null,
        7,
        {},
        [],
        "",
        value.replace("acph1.", "acph2."),
        value.replace("acph1.", "ACPH1."),
        `acph1..${ciphertext!}`,
        `acph1.${nonce!}.`,
        `acph1.${nonce!}=.${ciphertext!}`,
        `acph1.${nonce!}.${ciphertext!}=`,
        `acph1.${nonce!}A.${ciphertext!}`,
        `acph1.${Buffer.alloc(11).toString("base64url")}.${ciphertext!}`,
        `acph1.${Buffer.alloc(13).toString("base64url")}.${ciphertext!}`,
        `acph1.${nonce!}.${Buffer.alloc(15).toString("base64url")}`,
        `acph1.${nonce!}.+${ciphertext!}`,
        `acph1.${nonce!}./${ciphertext!}`,
        value + ".extra",
        value + "\n",
        " " + value,
        value + "é",
        `acph1.${nonce!}.${"A".repeat(4096)}`,
      ])
        expectInvalid(() => reader.open(candidate as string));
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
    }
  });

  it("rejects noncanonical base64url aliases even when they decode to the same authenticated bytes", () => {
    const original = input();
    if ((Buffer.byteLength(JSON.stringify(plaintext(original))) + 16) % 3 === 0)
      original.connectionId += "x";
    const value = authenticated(plaintext(original));
    const [, nonce, ciphertext] = value.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(ciphertext!.at(-1)!);
    const alias = ciphertext!.slice(0, -1) + alphabet[last + 1]!;
    expect(ciphertext!.length % 4).not.toBe(0);
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(ciphertext!, "base64url"));
    expectInvalid(() => handles().open(`acph1.${nonce!}.${alias}`), [value]);
  });

  it.each(invalidInputs)(
    "rejects sealing %s without disclosing private values",
    (_label, alter) => {
      const candidate = alter(input());
      expectInvalid(() => handles().seal(candidate));
    },
  );

  it.each(invalidInputs)("rejects authenticated plaintext with %s", (_label, alter) => {
    const value = authenticatedInput(alter(input()));
    expectInvalid(() => handles().open(value), [value]);
  });

  it.each([
    [
      "unknown top-level field",
      (value: ReturnType<typeof plaintext>) => ({ ...value, cct: privateMarker }),
    ],
    ["missing version", (value: ReturnType<typeof plaintext>) => without(value, "version")],
    ["wrong version", (value: ReturnType<typeof plaintext>) => ({ ...value, version: 2 })],
    ["string version", (value: ReturnType<typeof plaintext>) => ({ ...value, version: "1" })],
    [
      "missing membership",
      (value: ReturnType<typeof plaintext>) => without(value, "membership_sha256"),
    ],
    [
      "foreign membership",
      (value: ReturnType<typeof plaintext>) => ({ ...value, membership_sha256: "b".repeat(64) }),
    ],
    [
      "uppercase membership",
      (value: ReturnType<typeof plaintext>) => ({ ...value, membership_sha256: "A".repeat(64) }),
    ],
    ["missing protocol", (value: ReturnType<typeof plaintext>) => without(value, "protocol")],
    ["wrong protocol", (value: ReturnType<typeof plaintext>) => ({ ...value, protocol: "v2" })],
    ["missing transport", (value: ReturnType<typeof plaintext>) => without(value, "transport")],
    [
      "wrong transport",
      (value: ReturnType<typeof plaintext>) => ({ ...value, transport: "websocket" }),
    ],
  ] as const)("rejects the closed payload's %s", (_label, alter) => {
    const value = authenticated(alter(plaintext()));
    expectInvalid(() => handles().open(value), [value]);
  });

  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)])(
    "rejects an invalid configured membership digest %j safely",
    (sha) => expectInvalid(() => handles(key, sha)),
  );

  it("retains an old but valid original registration beyond the ten-second creation deadline", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
      const value = handles().seal(input());
      vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
      expect(handles().open(value)).toEqual(plaintext());
    } finally {
      vi.useRealTimers();
    }
  });
});
