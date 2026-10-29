import { describe, expect, it } from "vitest";
import {
  recordTokenCalibration,
  seedTokenCalibration,
  tokenCalibrationRatio,
} from "../../src/application/token-calibration.js";
import { snapshot } from "../support/fixtures.js";

describe("token calibration", () => {
  it("uses a non-decreasing persisted floor and interpolated p95 of valid observations", () => {
    const run = snapshot();
    run.modelProfileId = "calibration-percentile";
    expect(tokenCalibrationRatio(run)).toBe(1);
    recordTokenCalibration(run, 100, 100);
    recordTokenCalibration(run, 100, 300);
    expect(tokenCalibrationRatio(run)).toBeCloseTo(2.9);
    seedTokenCalibration(run, 4);
    recordTokenCalibration(run, 100, 10);
    expect(tokenCalibrationRatio(run)).toBe(4);
  });

  it("isolates organizations, profiles, model names and tokenizer revisions", () => {
    const run = snapshot();
    run.modelProfileId = "calibration-isolation";
    seedTokenCalibration(run, 3);
    for (const different of [
      { ...run, organizationId: "another-organization" },
      { ...run, modelProfileId: "another-profile" },
      {
        ...run,
        executionSpec: {
          ...run.executionSpec,
          model: { ...run.executionSpec.model, tokenizer: "o200k" as const },
        },
      },
    ])
      expect(tokenCalibrationRatio(different)).toBe(1);
  });

  it("ignores invalid samples and retains at most the newest 128 observations", () => {
    const run = snapshot();
    run.modelProfileId = "calibration-window";
    for (const invalid of [NaN, Infinity, -1, 1.5]) recordTokenCalibration(run, 100, invalid);
    recordTokenCalibration(run, 0, 100);
    expect(tokenCalibrationRatio(run)).toBe(1);
    recordTokenCalibration(run, 1, 100);
    for (let index = 0; index < 128; index += 1) recordTokenCalibration(run, 100, 100);
    expect(tokenCalibrationRatio(run)).toBe(1);
  });
});
