import assert from "node:assert/strict";
import test from "node:test";
import {
  probeCommand,
  inspectProbe,
  inspectTargetHistory,
} from "./network-evidence.mjs";

const input = { phase: "allowed", nonce: "abc123" };
const response = {
  uid: 1000,
  gid: 1000,
  tcp: {
    ok: true,
    elapsed_ms: 10,
    body: { phase: "allowed", nonce: "abc123" },
  },
  dns: { addresses: ["172.25.0.3"], elapsed_ms: 10 },
};
test("probe uses a bounded direct TCP client under the ordinary Runtime user", () => {
  const script = probeCommand(input);
  assert(script.includes("socket.AF_INET, socket.SOCK_STREAM"));
  assert(script.includes("1.1.1.1"));
  assert(script.includes("RES_OPTIONS"));
  assert(script.includes("os.getuid()"));
  assert(!script.includes("curl") && !script.includes("HTTP_PROXY"));
  assert.throws(() => probeCommand({ ...input, nonce: "'; injected" }));
});
test("allowed probe must echo the unique request and resolve the real fixture", () =>
  inspectProbe(response, input, "172.25.0.3"));
test("deny requires an explicit reset/rejection and bounded resolver failure", () => {
  const r = {
    uid: 1000,
    gid: 1000,
    tcp: { ok: false, errno: 111, elapsed_ms: 10 },
    dns: { error: -3, elapsed_ms: 10 },
    dns_tcp: { ok: false, errno: 111, elapsed_ms: 10 },
  };
  inspectProbe(r, { ...input, phase: "denied" }, "172.25.0.3");
  assert.throws(() =>
    inspectProbe(
      {
        ...r,
        dns_tcp: { ok: false, errno: 110, timed_out: true, elapsed_ms: 1000 },
      },
      { ...input, phase: "denied" },
      "172.25.0.3",
    ),
  );
  for (const tcp of [
    { ok: true },
    { ok: false, errno: 110, elapsed_ms: 2000 },
    { ok: false, errno: 111, elapsed_ms: 3000 },
  ])
    assert.throws(() =>
      inspectProbe({ ...r, tcp }, { ...input, phase: "denied" }, "172.25.0.3"),
    );
});
for (const [name, mutate] of [
  [
    "root",
    (r) => {
      r.uid = 0;
    },
  ],
  [
    "wrong target",
    (r) => {
      r.tcp.body.nonce = "other";
    },
  ],
  [
    "wrong phase",
    (r) => {
      r.tcp.body.phase = "other";
    },
  ],
  [
    "wrong DNS",
    (r) => {
      r.dns.addresses = ["1.2.3.4"];
    },
  ],
  [
    "unavailable endpoint",
    (r) => {
      r.tcp.ok = false;
    },
  ],
])
  test(`rejects network evidence: ${name}`, () => {
    const r = structuredClone(response);
    mutate(r);
    assert.throws(() => inspectProbe(r, input, "172.25.0.3"));
  });
test("target history cannot hide denied traffic or duplicate effects", () => {
  const expected = [
    { phase: "allowed", nonce: "abc123" },
    { phase: "restored", nonce: "def456" },
  ];
  const seen = expected.map((v) => ({ ...v, peer: "172.25.0.2" }));
  inspectTargetHistory({ requests: seen, errors: [] }, expected, "172.25.0.2");
  for (const requests of [
    seen.slice(1),
    [...seen, seen[0]],
    [...seen, { phase: "denied" }],
    seen.map((s) => ({ ...s, peer: "other" })),
  ])
    assert.throws(() =>
      inspectTargetHistory({ requests, errors: [] }, expected, "172.25.0.2"),
    );
});

for (const phase of ["held-a", "held-b"])
  test(`${phase} proves old-socket behavior, not a reconnect`, () => {
    const r = structuredClone(response);
    r.tcp.body.phase = phase;
    r.same_socket = true;
    r.dns_after = ["172.25.0.3"];
    r.push =
      phase === "held-a"
        ? { ok: false, timed_out: true }
        : { ok: true, body: { push: input.nonce } };
    r.continued =
      phase === "held-a"
        ? { ok: false, errno: 104, elapsed_ms: 5 }
        : { ok: true, body: { phase: "held-b-next", nonce: input.nonce } };
    inspectProbe(r, { ...input, phase }, "172.25.0.3");
    for (const mutate of [
      (v) => (v.same_socket = false),
      (v) => (v.push = {}),
      (v) =>
        (v.continued = {
          ok: false,
          errno: 110,
          timed_out: true,
          elapsed_ms: 2000,
        }),
    ]) {
      const other = structuredClone(r);
      mutate(other);
      assert.throws(() =>
        inspectProbe(other, { ...input, phase }, "172.25.0.3"),
      );
    }
  });
