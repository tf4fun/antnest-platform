const types = new Set([
  "AssertionError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "TypeError",
  "RangeError",
]);
const codes = new Set(["ERR_ASSERTION", "ABORT_ERR", "ENOENT"]);

// CI excludes private error dumps. Preserve bounded source-only causal facts
// there as well, never messages, assertion values, request URLs or credentials.
export function survivorFailure(error, stage, root) {
  const seen = new Set();
  const receipt = (value, depth) => {
    if (!value || seen.has(value) || seen.size >= 16 || depth > 4) return;
    seen.add(value);
    const prefix = `file://${root}`;
    const frames = [
      ...new Set(
        (typeof value.stack === "string" ? value.stack.slice(0, 8000) : "")
          .split("\n")
          .flatMap((line) => {
            const at = line.indexOf(prefix);
            if (at < 0) return [];
            const location = line.slice(at + prefix.length).replace(/\)$/, "");
            return /^[\w./-]+\.(?:mjs|js|ts):\d+:\d+$/u.test(location) &&
              !location.split("/").includes("..")
              ? [location]
              : [];
          }),
      ),
    ].slice(0, 8);
    const row = {
      type: types.has(value.name) ? value.name : "Error",
      ...(codes.has(value.code) ? { code: value.code } : {}),
      frames,
    };
    if (Array.isArray(value.errors)) {
      const errors = value.errors.slice(0, 8).flatMap((error) => {
        const child = receipt(error, depth + 1);
        return child ? [child] : [];
      });
      if (errors.length) row.errors = errors;
    }
    const cause = receipt(value.cause, depth + 1);
    if (cause) row.cause = cause;
    return row;
  };
  return { stage, ...(receipt(error, 0) ?? { type: "Error", frames: [] }) };
}
