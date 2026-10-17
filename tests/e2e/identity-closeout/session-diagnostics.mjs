import assert from "node:assert/strict";
import { hasError } from "../acp-plan/requests.mjs";

const fields = (rows) => {
  const result = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  assert.equal(
    Object.keys(result).length,
    rows.length,
    "duplicate Session diagnostic field",
  );
  return result;
};

export function assertSessionSuccess(span, allowedTags = {}) {
  assert(
    !hasError(span) || Object.hasOwn(allowedTags, "error"),
    "unrelated Session Trace error",
  );
  let httpStatus;
  for (const group of [
    span.tags ?? [],
    ...(span.logs ?? []).map((event) => event.fields ?? []),
  ]) {
    fields(group);
    for (const { key, value } of group) {
      if (["http.response.status_code", "http.status_code"].includes(key)) {
        const status =
          typeof value === "string" && /^(101|2\d{2})$/u.test(value)
            ? Number(value)
            : value;
        assert(
          Number.isInteger(status) &&
            (status === 101 || (status >= 200 && status < 300)),
          "unrelated Session HTTP failure status",
        );
        if (httpStatus !== undefined)
          assert.equal(status, httpStatus, "conflicting Session HTTP status");
        httpStatus = status;
      }
      if (key === "level")
        assert(
          ["TRACE", "DEBUG", "INFO"].includes(value),
          "unowned Session log diagnostic",
        );
      if (group === span.tags && Object.hasOwn(allowedTags, key)) {
        assert.equal(
          value,
          allowedTags[key],
          "contradictory Session diagnostic",
        );
        continue;
      }
      if (["rpc.response.status_code", "jsonrpc.error_code"].includes(key))
        assert.equal(value, 0, "unrelated Session RPC failure status");
      if (
        key === "outcome" ||
        key.endsWith(".outcome") ||
        key === "antnest.result"
      )
        assert(
          ["success", "ok", "completed", "committed", "admitted"].includes(
            value,
          ),
          "contradictory Session success result",
        );
      else if (
        /^(error($|\.)|exception\.|antnest\.(error\.|cancellation\.|stream\.termination$|http\.request_cancelled$)|otel\.status_|http\.transport\.error\.|db\.response\.status_code$)/u.test(
          key,
        )
      )
        assert(
          (key === "error" && value === false) ||
            (key === "error.type" && value === "") ||
            (key === "antnest.error.class" && value === "none") ||
            (key === "otel.status_code" &&
              ["OK", "UNSET", 0, 1].includes(value)),
          "unrelated Session success diagnostic",
        );
      else if (key === "event")
        assert(
          ![
            "error",
            "exception",
            "antnest.error",
            "antnest.cancelled",
            "antnest.stream.termination",
          ].includes(value),
          "unproved Session event",
        );
    }
  }
}
