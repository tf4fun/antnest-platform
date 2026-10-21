// Fixture parser for the workspace-bridge delivery protocol. The independent
// test harness does not depend on Agent UI source; only TypeScript types differ.
export function parseDeliveryMark(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value;
  if (record.kind === "checkpoint") {
    if (!exactKeys(record, ["kind", "sequence"]) || !revision(record.sequence))
      return null;
    return { kind: "checkpoint", sequence: record.sequence };
  }
  if (
    record.kind !== "part" ||
    !exactKeys(record, [
      "kind",
      "sequence",
      "partIndex",
      "partCount",
      "runId",
      "messageId",
    ])
  )
    return null;
  if (
    !revision(record.sequence) ||
    record.sequence === 0 ||
    !revision(record.partIndex) ||
    !revision(record.partCount) ||
    record.partCount === 0 ||
    record.partIndex >= record.partCount ||
    !(record.runId === null || identifier(record.runId)) ||
    !identifier(record.messageId)
  )
    return null;
  return {
    kind: "part",
    sequence: record.sequence,
    partIndex: record.partIndex,
    partCount: record.partCount,
    runId: record.runId,
    messageId: record.messageId,
  };
}

function revision(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function exactKeys(value, names) {
  const keys = Object.keys(value);
  return (
    keys.length === names.length && keys.every((key) => names.includes(key))
  );
}
