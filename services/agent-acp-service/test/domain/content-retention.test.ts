import { describe, expect, it } from "vitest";
import { parseContentRetentionConfig } from "../../src/domain/content-retention.js";

describe("parseContentRetentionConfig", () => {
  it("applies the contract defaults", () => {
    expect(parseContentRetentionConfig({})).toEqual({
      deletedSessionRetentionMs: 30 * 24 * 60 * 60 * 1000,
      purgeBatch: 500,
      purgeIntervalMs: 60_000,
    });
  });

  it.each([
    ["1ms", 1],
    ["250ms", 250],
    ["1s", 1_000],
    ["90s", 90_000],
    ["2m", 120_000],
    ["12h", 43_200_000],
    ["30d", 2_592_000_000],
    ["3650d", 315_360_000_000],
  ])("accepts retention duration %j", (value, ms) => {
    expect(
      parseContentRetentionConfig({ ANTNEST_ACP_DELETED_SESSION_RETENTION: value })
        .deletedSessionRetentionMs,
    ).toBe(ms);
  });

  it("treats the literal 0 retention as disabled", () => {
    expect(
      parseContentRetentionConfig({ ANTNEST_ACP_DELETED_SESSION_RETENTION: "0" })
        .deletedSessionRetentionMs,
    ).toBe(0);
  });

  it.each([
    "0d",
    "0s",
    "3651d",
    "315360000001ms",
    "1",
    "30",
    "30days",
    "-1d",
    "1.5d",
    " 30d",
    "30d ",
    "",
    "abc",
    "999999999999999999999d",
  ])("rejects invalid retention %j", (value) => {
    expect(() =>
      parseContentRetentionConfig({ ANTNEST_ACP_DELETED_SESSION_RETENTION: value }),
    ).toThrow();
  });

  it.each([
    ["1", 1],
    ["250", 250],
    ["500", 500],
  ])("accepts batch bound %j", (value, batch) => {
    expect(parseContentRetentionConfig({ ANTNEST_ACP_PURGE_BATCH: value }).purgeBatch).toBe(batch);
  });

  it.each(["0", "501", "-1", "1.5", "abc", " 5", "5 ", "", "100000000000000000000"])(
    "rejects invalid batch %j",
    (value) => {
      expect(() => parseContentRetentionConfig({ ANTNEST_ACP_PURGE_BATCH: value })).toThrow();
    },
  );

  it.each([
    ["1ms", 1],
    ["60s", 60_000],
    ["1h", 3_600_000],
  ])("accepts interval %j", (value, ms) => {
    expect(parseContentRetentionConfig({ ANTNEST_ACP_PURGE_INTERVAL: value }).purgeIntervalMs).toBe(
      ms,
    );
  });

  it.each(["0", "0s", "3600001ms", "61m", "1", "abc", " 60s", "60s ", ""])(
    "rejects invalid interval %j",
    (value) => {
      expect(() => parseContentRetentionConfig({ ANTNEST_ACP_PURGE_INTERVAL: value })).toThrow();
    },
  );

  it("reports the offending environment variable name", () => {
    expect(() => parseContentRetentionConfig({ ANTNEST_ACP_PURGE_BATCH: "0" })).toThrow(
      /ANTNEST_ACP_PURGE_BATCH/u,
    );
    expect(() =>
      parseContentRetentionConfig({ ANTNEST_ACP_DELETED_SESSION_RETENTION: "x" }),
    ).toThrow(/ANTNEST_ACP_DELETED_SESSION_RETENTION/u);
    expect(() => parseContentRetentionConfig({ ANTNEST_ACP_PURGE_INTERVAL: "x" })).toThrow(
      /ANTNEST_ACP_PURGE_INTERVAL/u,
    );
  });
});
