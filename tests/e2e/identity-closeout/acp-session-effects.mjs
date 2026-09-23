import assert from "node:assert/strict";

const phases = ["v1-admitted", "v1-recovered", "v2-admitted", "v2-recovered"];

export function assertSessionEffects(text, phase) {
  const index = phases.indexOf(phase);
  assert(index >= 0, "unknown execution phase");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Bash evidence is not structured JSON");
  }
  assert(
    result?.exit_code === 0 &&
      result.stderr === "" &&
      result.truncated === false &&
      result.effect_state === "settled",
    "Bash did not succeed with a complete, settled result",
  );
  assert(
    result.stdout === phases.slice(0, index + 1).join("\n") + "\n",
    "Bash stdout does not show exactly one ordered file effect per Run",
  );
}

export function assertStoredSessionEffects(blocks, phase) {
  assert(
    Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === "text",
    "missing or ambiguous persisted Bash result",
  );
  assertSessionEffects(blocks[0].text, phase);
}
