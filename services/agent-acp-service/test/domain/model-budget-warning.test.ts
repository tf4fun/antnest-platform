import { describe, expect, it } from "vitest";
import {
  budgetWarningFactSchema,
  budgetWarningNotice,
  budgetWarningNoticesSchema,
} from "../../src/domain/model-budget-warning.js";

function daily() {
  return {
    scope: "organization_daily" as const,
    periodStart: "2026-10-25",
    limit: "9007199254740993",
    used: "900719925474099312345",
    unknownCost: false,
  };
}

function monthly() {
  return {
    ...daily(),
    scope: "organization_monthly" as const,
    periodStart: "2026-10-01",
  };
}

function noticeText(notice: ReturnType<typeof budgetWarningNotice>): string {
  expect(Object.keys(notice).sort()).toEqual(["content", "kind", "messageId"]);
  expect(notice.kind).toBe("agent_message");
  expect(notice.content).toHaveLength(1);
  const block = notice.content[0];
  expect(block.type).toBe("text");
  expect(typeof block.text).toBe("string");
  expect(Object.keys(block).sort()).toEqual(["text", "type"]);
  return block.text;
}

describe("soft model budget warning facts and notices", () => {
  it("preserves exact decimal precision, zero and explicit unknown cost without coercion", () => {
    for (const fact of [
      daily(),
      monthly(),
      { ...monthly(), limit: "0", used: "0", unknownCost: true },
    ]) {
      const original = structuredClone(fact);
      expect(budgetWarningFactSchema.parse(fact)).toStrictEqual(original);
      expect(fact).toStrictEqual(original);
    }
  });

  it("rejects foreign scopes, invalid UTC dates, missing fields and extra facts", () => {
    for (const invalid of [
      null,
      [],
      { ...daily(), scope: "run_cost" },
      { ...daily(), scope: "organization_daily\n" },
      { ...daily(), periodStart: "not-a-date" },
      { ...daily(), periodStart: "2026-02-30" },
      { ...daily(), periodStart: "2026-1-01" },
      { ...daily(), periodStart: "2026-10-25T00:00:00Z" },
      { ...daily(), periodStart: "2026-10-25\n" },
      { ...daily(), unknownCost: "true" },
      { ...daily(), unknownCost: undefined },
      { ...daily(), credential: "private-warning-canary" },
    ])
      expect(budgetWarningFactSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects numeric, negative, fractional, noncanonical or newline monetary values", () => {
    for (const field of ["limit", "used"])
      for (const invalid of [
        0,
        1,
        Number.MAX_SAFE_INTEGER + 1,
        null,
        undefined,
        "",
        "00",
        "01",
        "-1",
        "1.5",
        "1e3",
        "2\n",
        " 2",
      ])
        expect(budgetWarningFactSchema.safeParse({ ...daily(), [field]: invalid }).success).toBe(
          false,
        );
  });

  it("builds only the existing agent_message shape with the original precision and UTC bucket", () => {
    const fact = daily();
    const original = structuredClone(fact);
    const notice = budgetWarningNotice("budget-warning-daily", fact);
    expect(notice.messageId).toBe("budget-warning-daily");
    const text = noticeText(notice);
    expect(text).toMatch(/\bsoft\b/iu);
    expect(text).toMatch(/\bUTC\b/u);
    expect(text).toContain(fact.periodStart);
    expect(text).toContain(fact.limit);
    expect(text).toContain(fact.used);
    expect(text).toMatch(/\bUSD\b/u);
    expect(text).toMatch(/\bmicrodollars\b/iu);
    expect(fact).toStrictEqual(original);
  });

  it("explicitly describes unknown cost while preserving an explicit zero threshold and usage", () => {
    const fact = { ...monthly(), limit: "0", used: "0", unknownCost: true };
    const notice = budgetWarningNotice("budget-warning-unknown", fact);
    const text = noticeText(notice);
    expect(text).toMatch(/\bsoft\b/iu);
    expect(text).toMatch(/\bunknown\b/iu);
    expect(text).toMatch(/\b0\b/u);
    expect(text).toContain(fact.periodStart);
    expect(text).toMatch(/\bUSD\b/u);
    expect(text).toMatch(/\bmicrodollars\b/iu);
  });

  it("accepts zero, one or two exact static notices but rejects a third", () => {
    const first = budgetWarningNotice("budget-warning-daily", daily());
    const second = budgetWarningNotice("budget-warning-monthly", monthly());
    const third = budgetWarningNotice("budget-warning-next-day", {
      ...daily(),
      periodStart: "2026-10-26",
    });
    for (const notices of [[], [first], [first, second]])
      expect(budgetWarningNoticesSchema.parse(notices)).toStrictEqual(notices);
    expect(budgetWarningNoticesSchema.safeParse([first, second, third]).success).toBe(false);
  });

  it("rejects invalid notice envelopes, non-text content and nested private fields", () => {
    const notice = budgetWarningNotice("budget-warning-daily", daily());
    for (const invalid of [
      null,
      {},
      [null],
      [{ ...notice, kind: "usage" }],
      [{ ...notice, messageId: undefined }],
      [{ ...notice, messageId: 1 }],
      [{ ...notice, budget: daily() }],
      [{ ...notice, content: [] }],
      [{ ...notice, content: "soft warning" }],
      [{ ...notice, content: [{ type: "text", text: 1 }] }],
      [{ ...notice, content: [{ type: "image", data: "private-warning-canary" }] }],
      [
        {
          ...notice,
          content: [{ type: "text", text: "soft warning", credential: "private-warning-canary" }],
        },
      ],
    ])
      expect(budgetWarningNoticesSchema.safeParse(invalid).success).toBe(false);
  });
});
