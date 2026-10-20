import assert from "node:assert/strict";

function integer(value, nonnegative = false) {
  assert(typeof value === "string" && /^(?:0|-?[1-9][0-9]*)$/u.test(value));
  const parsed = BigInt(value);
  assert(!nonnegative || parsed >= 0n);
  return parsed;
}

function interval(value) {
  const lower = integer(value.lower_ns);
  const upper = integer(value.upper_ns);
  assert(lower <= upper, "inverted interval");
  return [lower, upper];
}

const result = (lower, upper) => ({
  lower_ns: String(lower),
  upper_ns: String(upper),
});

// With monotonic clocks at the same rate, causality bounds remote minus local.
// No midpoint is selected and no original timestamp is modified.
export function clockOffsetBounds(sample) {
  const g0 = integer(sample.local_send_ns, true);
  const n1 = integer(sample.remote_receive_ns, true);
  const n2 = integer(sample.remote_send_ns, true);
  const g3 = integer(sample.local_receive_ns, true);
  assert(g0 <= g3 && n1 <= n2, "inverted clock sample");
  assert(n2 - n1 <= g3 - g0, "remote elapsed exceeds complete round trip");
  return result(n2 - g3, n1 - g0);
}

// Conditional on a fixed offset during this phase, every observation applies.
// A conflicting observation makes the entire phase indeterminate; none is dropped.
export function phaseOffsetBounds(observations) {
  assert(Array.isArray(observations) && observations.length > 0);
  const values = observations.map(interval);
  const lower = values.reduce(
    (result, value) => (result > value[0] ? result : value[0]),
    values[0][0],
  );
  const upper = values.reduce(
    (result, value) => (result < value[1] ? result : value[1]),
    values[0][1],
  );
  return lower <= upper ? result(lower, upper) : null;
}

// Cover both bracketing observations, retaining observed drift and uncertainty.
// This does not prove that no unobserved clock step happened between them.
export function bracketOffsetBounds(before, after) {
  const [bl, bu] = interval(before);
  const [al, au] = interval(after);
  return {
    ...result(bl < al ? bl : al, bu > au ? bu : au),
    overlaps: bl <= au && al <= bu,
  };
}

export function intervalDifference(remote, local, offset) {
  const [rl, ru] = interval(remote);
  const [ll, lu] = interval(local);
  const [ol, ou] = interval(offset);
  return result(rl - ou - lu, ru - ol - ll);
}
