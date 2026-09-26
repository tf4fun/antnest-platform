import assert from "node:assert/strict";
import test from "node:test";
import { inspectSingleNodeMembership } from "./temporal-membership.mjs";

const heartbeat = (port, address = "127.0.0.1") =>
  JSON.stringify({
    msg: "Membership heartbeat upserted successfully",
    port,
    address,
  });
const ready = () => [6933, 6934, 6935, 6939].map((port) => heartbeat(port));
test("all four local roles can advertise a stable single-container address", () => {
  const result = inspectSingleNodeMembership(
    ["Starting Temporal", ...ready(), heartbeat(6933)].join("\n"),
  );
  assert.deepEqual(result, {
    address: "127.0.0.1",
    roles: 4,
    bootstrap_retries: 0,
  });
});
test("an incomplete role set cannot prove cluster membership", () => {
  assert.throws(
    () =>
      inspectSingleNodeMembership(
        [...ready().slice(0, 3), heartbeat(6933)].join("\n"),
      ),
    /deep-equal/,
  );
});
test("Docker interface address selection cannot pass stable restart evidence", () => {
  assert.throws(
    () =>
      inspectSingleNodeMembership(
        [...ready(), heartbeat(6933, "192.168.214.7")].join("\n"),
      ),
    /reallocated Docker interface/,
  );
});
test("a later healthy ring does not hide an earlier bootstrap failure", () => {
  assert.throws(
    () =>
      inspectSingleNodeMembership(
        [
          ...ready(),
          JSON.stringify({ msg: "unable to bootstrap ringpop. retrying" }),
        ].join("\n"),
      ),
    /failed bootstrap attempt/,
  );
});
