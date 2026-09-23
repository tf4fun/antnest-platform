import assert from "node:assert/strict";

export function assertSuccessfulSpan(span, { rpcContent = false } = {}) {
  const values = [
    ...(span.tags ?? []),
    ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
  ];
  for (const { key, value } of values) {
    assert(
      (rpcContent || !/^antnest\.payload\./u.test(key)) &&
        !/^http\.(request|response)\.headers?(?:$|\.)/u.test(key),
      "unexpected header values or payload",
    );
    if (/^http\.(request|response)\.body(?:$|\.)/u.test(key)) {
      assert(
        /^http\.(request|response)\.body\.size$/u.test(key) &&
          Number.isSafeInteger(value) &&
          value >= 0,
        "HTTP body metadata must be a byte count",
      );
    }
    assert(
      !(key === "error" && value === true) &&
        !/^(error\.|exception\.|antnest\.error\.)/u.test(key) &&
        !(key === "otel.status_code" && ["ERROR", 2].includes(value)) &&
        !(key === "antnest.outcome" && value === "failure") &&
        !(
          key === "event" &&
          ["error", "exception", "antnest.error"].includes(value)
        ),
      "successful request contains an error observation",
    );
  }
}
