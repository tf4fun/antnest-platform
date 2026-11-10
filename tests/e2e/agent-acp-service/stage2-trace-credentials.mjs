import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { assertNoCredentials } from "./stage2-boundary-evidence.mjs";

// Identity's enabled-capture contract recursively redacts registered secrets
// in RPC payloads, replacing credential values with the published marker. The
// stored trace stays byte-for-byte unchanged.
export function assertStage2TraceCredentials(trace, { secrets, sessions }) {
  assert(Array.isArray(secrets) && Array.isArray(sessions));
  const view = structuredClone(trace);
  for (const span of view.spans) {
    if (view.processes[span.processID]?.serviceName !== "identity-service")
      continue;
    const expected = {
      "span.kind": "server",
      "rpc.system.name": "antnest.http-json",
      "rpc.service": "identity",
      "rpc.method": "resolve_access_token",
      "http.request.method": "POST",
      "http.route": "/rpc/identity/resolve-access-token",
    };
    if (
      Object.entries(expected).some(([key, value]) => tag(span, key) !== value)
    )
      continue;
    for (const key of Object.keys(expected))
      assert.equal(span.tags.filter((row) => row.key === key).length, 1);
    for (const event of span.logs ?? []) {
      if (
        !event.fields.some(
          (row) => row.key === "event" && row.value === "antnest.request",
        )
      )
        continue;
      assert.equal(
        new Set(event.fields.map((row) => row.key)).size,
        event.fields.length,
      );
      const capture = event.fields.find(
        (row) => row.key === "antnest.payload.json",
      );
      if (!capture) continue;
      const value = JSON.parse(capture.value);
      // The captured Resolve DTO is compact JSON with ASCII credential/profile
      // fields. Reject any lossy parse (including duplicate keys) before the
      // redaction-marker check, so earlier secret values cannot disappear.
      assert(
        JSON.stringify(value) === capture.value,
        "lossy Identity Resolve capture",
      );
      if (
        !value ||
        typeof value !== "object" ||
        !Object.hasOwn(value, "access_token")
      )
        continue;
      assert.equal(
        value.access_token,
        "[REDACTED]",
        "Resolve credentials must be redacted",
      );
      assert(["console", "workspace", "session"].includes(value.profile));
      assert(
        Object.keys(value).every((key) =>
          ["access_token", "profile", "agent_id"].includes(key),
        ),
      );
    }
  }
  assertNoCredentials(view);
  assertSecretFree(JSON.stringify(view), [...secrets, ...sessions]);
}
