import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  OwnerIncarnation,
  OwnerIncarnationError,
  type OwnerProbeRequest,
  type OwnerRegistration,
  type OwnerRegistrationRequest,
} from "../../src/application/owner-incarnation.js";

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const nonce = /^[0-9a-f]{64}$/u;
const receiptId = "abcdef01-2345-4abc-8abc-1234567890ab";

function registration(request: Readonly<OwnerRegistrationRequest>): OwnerRegistration {
  return {
    registration_id: receiptId,
    member_id: request.member_id,
    incarnation_id: request.incarnation_id,
  };
}

function probe(request: Readonly<OwnerRegistrationRequest>): OwnerProbeRequest {
  return { ...request, challenge: randomBytes(32).toString("hex") };
}

function differentNonce(value: string): string {
  return value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
}

function expectOwnerError(
  operation: () => unknown,
  code: "acp_probe_intent_mismatch" | "acp_registration_unavailable",
  privateValues: readonly string[],
): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OwnerIncarnationError);
  if (!(failure instanceof OwnerIncarnationError))
    throw new Error("Expected owner incarnation error");
  expect(failure.code).toBe(code);
  for (const value of privateValues) expect(failure.message).not.toContain(value);
}

describe("OwnerIncarnation pending registration", () => {
  it("creates fresh real UUIDv4 and 32-byte hexadecimal nonce identities for each process incarnation", () => {
    const owners = Array.from({ length: 16 }, () => new OwnerIncarnation("acp-a"));
    try {
      const requests = owners.map((owner) => owner.registrationRequest());
      for (const request of requests) {
        expect(Object.keys(request).sort()).toEqual([
          "incarnation_id",
          "member_id",
          "registration_nonce",
        ]);
        expect(request.member_id).toBe("acp-a");
        expect(request.incarnation_id).toMatch(uuidV4);
        expect(request.registration_nonce).toMatch(nonce);
        expect(Buffer.from(request.registration_nonce, "hex")).toHaveLength(32);
        expect(Object.isFrozen(request)).toBe(true);
      }
      expect(new Set(requests.map((request) => request.incarnation_id)).size).toBe(owners.length);
      expect(new Set(requests.map((request) => request.registration_nonce)).size).toBe(
        owners.length,
      );
      expect(owners.every((owner) => owner.currentRegistration() === undefined)).toBe(true);
    } finally {
      for (const owner of owners) owner.close();
    }
  });

  it("retains the same frozen registration tuple across retries and attempted caller mutation", () => {
    const owner = new OwnerIncarnation("acp-a");
    try {
      const first = owner.registrationRequest();
      const original = { ...first };
      expect(Reflect.set(first, "member_id", "acp-b")).toBe(false);
      expect(Reflect.set(first, "incarnation_id", randomUUID())).toBe(false);
      expect(
        Reflect.set(first, "registration_nonce", differentNonce(first.registration_nonce)),
      ).toBe(false);
      expect(Reflect.deleteProperty(first, "registration_nonce")).toBe(false);
      for (let attempt = 0; attempt < 3; attempt++) {
        const retried = owner.registrationRequest();
        expect(retried).toEqual(original);
        expect(Object.isFrozen(retried)).toBe(true);
      }
      expect(owner.currentRegistration()).toBeUndefined();
    } finally {
      owner.close();
    }
  });

  it("answers multiple independently challenged probes without consuming its pending intent", () => {
    const owner = new OwnerIncarnation("acp-a");
    try {
      const request = owner.registrationRequest();
      const first = probe(request);
      const second = { ...first, challenge: differentNonce(first.challenge) };
      for (const challenge of [first, first, second]) {
        expect(owner.probe(challenge)).toEqual(challenge);
        expect(owner.registrationRequest()).toEqual(request);
        expect(owner.currentRegistration()).toBeUndefined();
      }
      expect(owner.acceptRegistration(registration(request))).toEqual(registration(request));
    } finally {
      owner.close();
    }
  });

  it.each([
    ["different member", (request: OwnerProbeRequest) => ({ ...request, member_id: "acp-b" })],
    [
      "different incarnation",
      (request: OwnerProbeRequest) => ({ ...request, incarnation_id: randomUUID() }),
    ],
    [
      "different nonce",
      (request: OwnerProbeRequest) => ({
        ...request,
        registration_nonce: differentNonce(request.registration_nonce),
      }),
    ],
    [
      "missing nonce",
      (request: OwnerProbeRequest) => ({
        member_id: request.member_id,
        incarnation_id: request.incarnation_id,
        challenge: request.challenge,
      }),
    ],
    ["empty nonce", (request: OwnerProbeRequest) => ({ ...request, registration_nonce: "" })],
    ["null nonce", (request: OwnerProbeRequest) => ({ ...request, registration_nonce: null })],
  ] as const)(
    "rejects a probe with %s without disclosing or consuming the original nonce",
    (_label, alter) => {
      const owner = new OwnerIncarnation("acp-a");
      try {
        const request = owner.registrationRequest();
        const valid = probe(request);
        const candidate = alter(valid) as unknown as OwnerProbeRequest;
        expectOwnerError(() => owner.probe(candidate), "acp_probe_intent_mismatch", [
          request.registration_nonce,
          valid.challenge,
        ]);
        expect(owner.registrationRequest()).toEqual(request);
        expect(owner.probe(valid)).toEqual(valid);
        expect(owner.currentRegistration()).toBeUndefined();
      } finally {
        owner.close();
      }
    },
  );

  it("accepts only the matching registration and freezes every published registration snapshot", () => {
    const owner = new OwnerIncarnation("acp-a");
    try {
      const request = owner.registrationRequest();
      const input = registration(request);
      const expected = { ...input };
      const accepted = owner.acceptRegistration(input);
      expect(accepted).toEqual(expected);
      expect(Object.isFrozen(accepted)).toBe(true);
      const current = owner.currentRegistration();
      expect(current).toEqual(expected);
      expect(Object.isFrozen(current)).toBe(true);
      expect(Reflect.set(accepted, "registration_id", randomUUID())).toBe(false);
      expect(Reflect.deleteProperty(accepted, "member_id")).toBe(false);
      // Whether the implementation freezes or copies the input, callers cannot
      // replace the already accepted identity through their receipt reference.
      Reflect.set(input, "registration_id", randomUUID());
      expect(owner.currentRegistration()).toEqual(expected);
      expectOwnerError(() => owner.registrationRequest(), "acp_registration_unavailable", [
        request.registration_nonce,
      ]);
      expectOwnerError(() => owner.probe(probe(request)), "acp_probe_intent_mismatch", [
        request.registration_nonce,
      ]);
      expect(owner.currentRegistration()).toEqual(expected);
    } finally {
      owner.close();
    }
  });

  const invalidRegistrations: Array<[string, (value: OwnerRegistration) => unknown]> = [
    [
      "malformed registration UUID",
      (value: OwnerRegistration): OwnerRegistration => ({
        ...value,
        registration_id: "not-a-uuid",
      }),
    ],
    [
      "uppercase registration UUID",
      (value: OwnerRegistration) => ({ ...value, registration_id: receiptId.toUpperCase() }),
    ],
    [
      "wrong UUID version",
      (value: OwnerRegistration) => ({
        ...value,
        registration_id: receiptId.replace("-4abc-", "-1abc-"),
      }),
    ],
    [
      "wrong UUID variant",
      (value: OwnerRegistration) => ({
        ...value,
        registration_id: receiptId.replace("-8abc-", "-7abc-"),
      }),
    ],
    [
      "trailing registration UUID newline",
      (value: OwnerRegistration) => ({ ...value, registration_id: receiptId + "\n" }),
    ],
    ["different member", (value: OwnerRegistration) => ({ ...value, member_id: "acp-b" })],
    [
      "different incarnation",
      (value: OwnerRegistration) => ({ ...value, incarnation_id: randomUUID() }),
    ],
    [
      "uppercase incarnation UUID",
      (value: OwnerRegistration) => ({
        ...value,
        incarnation_id: "ABCDEF01-2345-4ABC-8ABC-1234567890AB",
      }),
    ],
    [
      "missing registration UUID",
      (value: OwnerRegistration) => ({
        member_id: value.member_id,
        incarnation_id: value.incarnation_id,
      }),
    ],
    [
      "missing member",
      (value: OwnerRegistration) => ({
        registration_id: value.registration_id,
        incarnation_id: value.incarnation_id,
      }),
    ],
    [
      "missing incarnation",
      (value: OwnerRegistration) => ({
        registration_id: value.registration_id,
        member_id: value.member_id,
      }),
    ],
    [
      "private extra field",
      (value: OwnerRegistration) => ({ ...value, registration_nonce: "PRIVATE_RECEIPT_NONCE" }),
    ],
    ["null receipt", () => null],
    ["array receipt", (): unknown[] => []],
  ];

  it.each(invalidRegistrations)(
    "rejects %s with a fixed safe error and retains the original pending tuple",
    (_label, alter) => {
      const owner = new OwnerIncarnation("acp-a");
      try {
        const request = owner.registrationRequest();
        const candidate = alter(registration(request)) as OwnerRegistration;
        expectOwnerError(
          () => owner.acceptRegistration(candidate),
          "acp_registration_unavailable",
          [request.registration_nonce, "PRIVATE_RECEIPT_NONCE"],
        );
        expect(owner.currentRegistration()).toBeUndefined();
        expect(owner.registrationRequest()).toEqual(request);
        const challenge = probe(request);
        expect(owner.probe(challenge)).toEqual(challenge);
        expect(owner.acceptRegistration(registration(request))).toEqual(registration(request));
      } finally {
        owner.close();
      }
    },
  );

  it.each(["pending", "registered"] as const)(
    "permanently closes a %s incarnation and cannot be revived by a late receipt",
    (state) => {
      const owner = new OwnerIncarnation("acp-a");
      const request = owner.registrationRequest();
      const receipt = registration(request);
      const challenge = probe(request);
      if (state === "registered") owner.acceptRegistration(receipt);
      owner.close();
      owner.close();
      const afterClose = owner.currentRegistration();
      expect(afterClose).toBeUndefined();
      for (let attempt = 0; attempt < 2; attempt++) {
        expectOwnerError(() => owner.registrationRequest(), "acp_registration_unavailable", [
          request.registration_nonce,
        ]);
        expectOwnerError(() => owner.probe(challenge), "acp_probe_intent_mismatch", [
          request.registration_nonce,
          challenge.challenge,
        ]);
        expectOwnerError(() => owner.acceptRegistration(receipt), "acp_registration_unavailable", [
          request.registration_nonce,
        ]);
        expect(owner.currentRegistration()).toEqual(afterClose);
      }
    },
  );
});
