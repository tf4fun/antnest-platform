import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { inspectIdentityTraceTopology } from "./support.mjs";
import { collectResolveTraceEvidence } from "../../support/gateway-resolution-evidence.mjs";

export function correlateOIDCRequests(expectations, received) {
  return expectations.map((expected) => ({
    ...expected,
    ...(expected.oidcRequests
      ? {
          oidcRequests: expected.oidcRequests.map((request) => {
            const matches = received.filter(
              (record) =>
                record.method === request.method &&
                record.url === request.url &&
                record.traceparent?.split("-")[1] === expected.traceID,
            );
            assert.equal(
              matches.length,
              1,
              "missing or duplicate actual IdP request",
            );
            assert.match(
              matches[0].traceparent,
              /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/,
            );
            assert.equal(matches[0].status, 200, "actual IdP request failed");
            return { ...request, spanID: matches[0].traceparent.split("-")[2] };
          }),
        }
      : {}),
  }));
}

export const identityEvidenceExitCode = (evidence) =>
  evidence.some((item) => item.strict_trace === "failed") ? 2 : 0;

export async function verifyIdentityEvidence(
  base,
  expectations,
  secrets,
  {
    request = fetch,
    wait = delay,
    attempts = 40,
    directory = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR,
    inspect = inspectIdentityTraceTopology,
    signal,
  } = {},
) {
  return collectResolveTraceEvidence(base, expectations, secrets, {
    request,
    wait,
    attempts,
    directory,
    inspect,
    signal,
  });
}
