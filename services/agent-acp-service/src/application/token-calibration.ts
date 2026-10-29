import type { RunExecutionSnapshot } from "../domain/types.js";

type Calibration = { floor: number; ratios: number[] };
const calibrations = new Map<string, Calibration>();

function key(snapshot: RunExecutionSnapshot): string {
  return JSON.stringify([
    snapshot.organizationId,
    snapshot.modelProfileId,
    snapshot.executionSpec.model.model,
    snapshot.executionSpec.model.tokenizer ?? "none",
  ]);
}

function entry(snapshot: RunExecutionSnapshot): Calibration {
  const identity = key(snapshot);
  let value = calibrations.get(identity);
  if (value === undefined) {
    value = { floor: 1, ratios: [] };
    if (calibrations.size >= 512) calibrations.delete(calibrations.keys().next().value!);
    calibrations.set(identity, value);
  }
  return value;
}

export function seedTokenCalibration(snapshot: RunExecutionSnapshot, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio < 0) return;
  const value = entry(snapshot);
  value.floor = Math.max(value.floor, ratio);
}

export function recordTokenCalibration(
  snapshot: RunExecutionSnapshot,
  estimated: number,
  actual: number,
): void {
  if (
    !Number.isSafeInteger(estimated) ||
    estimated <= 0 ||
    !Number.isSafeInteger(actual) ||
    actual < 0
  )
    return;
  const value = entry(snapshot);
  value.ratios.push(actual / estimated);
  if (value.ratios.length > 128) value.ratios.shift();
}

export function tokenCalibrationRatio(snapshot: RunExecutionSnapshot): number {
  const value = calibrations.get(key(snapshot));
  if (value === undefined) return 1;
  if (value.ratios.length === 0) return value.floor;
  const ordered = [...value.ratios].sort((left, right) => left - right);
  const position = (ordered.length - 1) * 0.95;
  const lower = Math.floor(position);
  const percentile =
    ordered[lower]! + (ordered[Math.ceil(position)]! - ordered[lower]!) * (position - lower);
  return Math.max(1, value.floor, percentile);
}
