import assert from "node:assert/strict";
import test from "node:test";
import * as intervals from "./clock-interval.mjs";
import {
  clockOffsetBounds,
  intervalDifference,
  bracketOffsetBounds,
} from "./clock-interval.mjs";

test("four actual observations bound remote minus local monotonic offset", () => {
  assert.deepEqual(
    clockOffsetBounds({
      local_send_ns: "100",
      remote_receive_ns: "1130",
      remote_send_ns: "1160",
      local_receive_ns: "200",
    }),
    { lower_ns: "960", upper_ns: "1030" },
  );
});

test("integer bounds preserve nanoseconds beyond Number precision and negative offsets", () => {
  assert.deepEqual(
    clockOffsetBounds({
      local_send_ns: "9007199254740993100",
      remote_receive_ns: "150",
      remote_send_ns: "160",
      local_receive_ns: "9007199254740993200",
    }),
    { lower_ns: "-9007199254740993040", upper_ns: "-9007199254740992950" },
  );
});

test("bracketing samples use a covering interval instead of assuming a fixed offset", () => {
  assert.deepEqual(
    bracketOffsetBounds(
      { lower_ns: "960", upper_ns: "1030" },
      { lower_ns: "980", upper_ns: "1070" },
    ),
    { lower_ns: "960", upper_ns: "1070", overlaps: true },
  );
  assert.deepEqual(
    bracketOffsetBounds(
      { lower_ns: "1", upper_ns: "2" },
      { lower_ns: "4", upper_ns: "5" },
    ),
    { lower_ns: "1", upper_ns: "5", overlaps: false },
  );
});

test("remote and local endpoint brackets retain full uncertainty", () => {
  assert.deepEqual(
    intervalDifference(
      { lower_ns: "1500", upper_ns: "1520" },
      { lower_ns: "400", upper_ns: "450" },
      { lower_ns: "960", upper_ns: "1030" },
    ),
    { lower_ns: "20", upper_ns: "160" },
  );
  assert.deepEqual(
    intervalDifference(
      { lower_ns: "1500", upper_ns: "1520" },
      { lower_ns: "470", upper_ns: "600" },
      { lower_ns: "960", upper_ns: "1030" },
    ),
    { lower_ns: "-130", upper_ns: "90" },
  );
});

test("invalid clock samples and impossible elapsed ordering reject", () => {
  const valid = {
    local_send_ns: "100",
    remote_receive_ns: "1130",
    remote_send_ns: "1160",
    local_receive_ns: "200",
  };
  for (const patch of [
    { local_send_ns: 100 },
    { local_send_ns: "01" },
    { local_send_ns: "-1" },
    { local_send_ns: "201" },
    { remote_send_ns: "1129" },
    { remote_send_ns: "1300" },
  ])
    assert.throws(() => clockOffsetBounds({ ...valid, ...patch }));
  assert.throws(() =>
    bracketOffsetBounds(
      { lower_ns: "2", upper_ns: "1" },
      { lower_ns: "0", upper_ns: "1" },
    ),
  );
  assert.throws(() =>
    intervalDifference(
      { lower_ns: "2", upper_ns: "1" },
      { lower_ns: "0", upper_ns: "1" },
      { lower_ns: "0", upper_ns: "1" },
    ),
  );
});

test("all observations constrain one fixed-offset phase, including a wide first exchange", () => {
  assert.deepEqual(
    intervals.phaseOffsetBounds([
      { lower_ns: "-9000", upper_ns: "10000" },
      { lower_ns: "960", upper_ns: "1100" },
      { lower_ns: "970", upper_ns: "1030" },
      { lower_ns: "980", upper_ns: "1050" },
      { lower_ns: "950", upper_ns: "1040" },
    ]),
    { lower_ns: "980", upper_ns: "1030" },
  );
});

test("inconsistent phase observations retain uncertainty rather than dropping an outlier", () => {
  assert.equal(
    intervals.phaseOffsetBounds([
      { lower_ns: "1", upper_ns: "2" },
      { lower_ns: "4", upper_ns: "5" },
    ]),
    null,
  );
  assert.deepEqual(
    intervals.phaseOffsetBounds([
      { lower_ns: "1", upper_ns: "2" },
      { lower_ns: "2", upper_ns: "3" },
    ]),
    { lower_ns: "2", upper_ns: "2" },
  );
  assert.throws(() => intervals.phaseOffsetBounds([]));
  assert.throws(() =>
    intervals.phaseOffsetBounds([{ lower_ns: "2", upper_ns: "1" }]),
  );
});
