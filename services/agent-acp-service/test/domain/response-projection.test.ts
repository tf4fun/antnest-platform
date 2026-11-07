import { describe, expect, it } from "vitest";
import { z } from "zod";

import { projectResponse } from "../../src/domain/response-projection.js";

const providerSchema = z.discriminatedUnion("enabled", [
  z.strictObject({
    enabled: z.literal(true),
    credential: z.strictObject({ ref: z.string(), version: z.string() }),
    endpoint: z.string(),
  }),
  z.strictObject({
    enabled: z.literal(false),
    endpoint: z.string(),
  }),
]);

const responseSchema = z.strictObject({
  organization_id: z.string(),
  revision: z.number().int().min(1),
  providers: z.array(providerSchema),
  metadata: z.strictObject({ label: z.string(), score: z.number().nullable() }).optional(),
  notes: z.record(z.string(), z.strictObject({ flag: z.boolean() })).optional(),
  opaque: z.unknown().optional(),
});

describe("response projection", () => {
  it("strips unknown members only from declared object shapes", () => {
    const input = {
      organization_id: "org-1",
      revision: 2,
      x_future_field: 1,
      providers: [
        {
          enabled: true,
          credential: { ref: "p", version: "r", extra: 1 },
          endpoint: "https://a",
          extension: { deep: true },
        },
        { enabled: false, endpoint: "https://b", extra_flag: 1 },
      ],
      metadata: { label: "x", score: null, future: 2 },
      notes: { custom: { flag: true, unknown_kept: 3 } },
      opaque: { arbitrary: { keys: [1, 2] } },
      trailing: "dropped",
    };
    const projected = projectResponse(responseSchema, input);
    expect(projected).toEqual({
      organization_id: "org-1",
      revision: 2,
      providers: [
        { enabled: true, credential: { ref: "p", version: "r" }, endpoint: "https://a" },
        { enabled: false, endpoint: "https://b" },
      ],
      metadata: { label: "x", score: null },
      notes: { custom: { flag: true } },
      opaque: { arbitrary: { keys: [1, 2] } },
    });
    expect(responseSchema.safeParse(projected).success).toBe(true);
  });

  it("keeps every union variant's declared keys so invalid members still fail", () => {
    const input = {
      organization_id: "org-1",
      revision: 2,
      providers: [{ enabled: false, endpoint: "https://b", credential: { ref: 7, version: "r" } }],
    };
    const projected = projectResponse(responseSchema, input);
    expect(responseSchema.safeParse(projected).success).toBe(false);
  });

  it("keeps rejection of invalid known fields after projection", () => {
    const invalid = [
      { organization_id: "org-1", revision: 0, providers: [], x: 1 },
      { revision: 2, providers: [], extra: 1 },
      {
        organization_id: "org-1",
        revision: 2,
        providers: [{ enabled: true, credential: "nope", endpoint: "https://a" }],
      },
    ];
    for (const input of invalid) {
      expect(responseSchema.safeParse(projectResponse(responseSchema, input)).success).toBe(false);
    }
  });

  it("drops every member of an empty declared object", () => {
    const empty = z.strictObject({});
    expect(projectResponse(empty, { x_future_field: 1, a: 2 })).toEqual({});
    expect(empty.safeParse(projectResponse(empty, { x: 1 })).success).toBe(true);

    const nested = z.strictObject({ empty: z.strictObject({}), ok: z.number() });
    expect(projectResponse(nested, { empty: { junk: 1 }, ok: 2, extra: true })).toEqual({
      empty: {},
      ok: 2,
    });
  });

  it("keeps arbitrary record keys own without touching Object.prototype", () => {
    const records = z.strictObject({
      notes: z.record(z.string(), z.strictObject({ flag: z.boolean() })),
    });
    const input: unknown = JSON.parse(
      `{"notes":{"__proto__":{"flag":true,"dropped":1},"regular":{"flag":false,"dropped":2}}}`,
    );
    const projected = projectResponse(records, input) as {
      notes: Record<string, unknown>;
    };
    expect(Object.prototype.hasOwnProperty.call(projected.notes, "__proto__")).toBe(true);
    expect(projected.notes.__proto__).toEqual({ flag: true });
    expect(projected.notes.regular).toEqual({ flag: false });
    expect(({} as Record<string, unknown>).flag).toBeUndefined();
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(records.safeParse(projected).success).toBe(true);
  });

  it("leaves the schema itself strict for request decoding", () => {
    const request = { organization_id: "org-1", revision: 2, providers: [], x_future_field: 1 };
    expect(responseSchema.safeParse(request).success).toBe(false);
  });
});
