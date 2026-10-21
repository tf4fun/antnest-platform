const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function responseBytes(record) {
  const chunks = record.response?.chunks;
  if (!Array.isArray(chunks)) return Buffer.alloc(0);
  check(
    chunks.every((chunk) => typeof chunk === "string"),
    "Gate response capture is invalid",
  );
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "base64")));
}

export function rpcMessages(state, baseline) {
  check(
    Array.isArray(state.records) &&
      Array.isArray(state.captureErrors) &&
      state.captureErrors.length === 0,
    "Gate did not retain complete bounded wire capture",
  );
  const result = [];
  for (const [index, record] of state.records.entries()) {
    if (!record.response) continue;
    const bytes = responseBytes(record);
    const before = responseBytes(baseline.records[index] ?? {});
    check(
      bytes.subarray(0, before.length).equals(before),
      "Gate changed an earlier wire capture",
    );
    if (bytes.length === before.length) continue;
    const type = record.response.contentType ?? "";
    let values = [];
    if (type.startsWith("text/event-stream")) {
      // Latin-1 preserves one character per captured byte for boundary offsets.
      // Scan the full saved prefix too: the baseline can split a separator,
      // while a frame that started before that baseline remains old evidence.
      let frameStart = 0;
      for (const boundary of bytes
        .toString("latin1")
        .matchAll(/\r?\n\r?\n/gu)) {
        const start = frameStart;
        frameStart = boundary.index + boundary[0].length;
        if (start < before.length) continue;
        const frame = bytes.subarray(start, boundary.index).toString("utf8");
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /u, ""))
          .join("\n");
        if (!data || data === "[DONE]") continue;
        values.push(JSON.parse(data));
      }
    } else if (
      type.startsWith("application/json") &&
      before.length === 0 &&
      record.response.complete
    ) {
      values = [JSON.parse(bytes.toString("utf8"))];
    }
    for (const value of values.flat())
      if (object(value) && value.jsonrpc === "2.0")
        result.push({ recordIndex: index, message: value });
  }
  return result;
}
