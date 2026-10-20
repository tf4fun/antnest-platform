import assert from "node:assert/strict";

const one = (rows, label) => {
  assert.equal(rows.length, 1, label);
  return rows[0];
};
const end = (span) => span.startTime + span.duration;

export function inspectBrowserFeedWitness(
  root,
  {
    reason,
    sourceTraceID,
    sourceSpanID,
    principal,
    agentId,
    mutationStart,
    lowerBound,
    upperBound,
    transportFailureAt,
  },
) {
  const feedMarkers = (root.logs ?? []).filter((event) =>
    event.fields?.some(
      (field) =>
        field.key === "event" && field.value === "antnest.stream.termination",
    ),
  );
  let feed;
  if (feedMarkers.length) {
    feed = one(feedMarkers, "one winning Gateway feed witness required");
    const fields = Object.fromEntries(
      feed.fields.map(({ key, value }) => [key, value]),
    );
    assert.equal(Object.keys(fields).length, feed.fields.length);
    assert(
      Number.isSafeInteger(fields["antnest.revocation.sequence"]) &&
        fields["antnest.revocation.sequence"] > 0,
    );
    assert.deepEqual(fields, {
      event: "antnest.stream.termination",
      source: "identity-session-feed",
      reason: "session_revoked",
      "antnest.revocation.reason": reason,
      "antnest.revocation.sequence": fields["antnest.revocation.sequence"],
      "antnest.revocation.trace_id": sourceTraceID,
      "antnest.revocation.span_id": sourceSpanID,
      "antnest.organization.id": principal.organization_id,
      "antnest.principal.id": principal.user_id,
      "antnest.membership.id": principal.membership_id,
      "antnest.agent.id": agentId,
    });
    assert(
      Number.isFinite(feed.timestamp) &&
        feed.timestamp >= root.startTime &&
        feed.timestamp <= end(root),
    );
    assert(
      feed.timestamp >= mutationStart &&
        feed.timestamp >= lowerBound &&
        feed.timestamp <= upperBound,
      "feed witness outside original mutation/closure window",
    );
  }
  const gatewayRoot = {
    ...root,
    logs: (root.logs ?? []).filter((event) => event !== feed),
  };
  if (feed && transportFailureAt !== undefined)
    assert(
      feed.timestamp <= transportFailureAt,
      "feed must precede the original upstream read failure",
    );
  return {
    event: feed,
    root: gatewayRoot,
    sequence: feed
      ? feed.fields.find((field) => field.key === "antnest.revocation.sequence")
          .value
      : undefined,
    sourceSpanID: feed ? sourceSpanID : undefined,
  };
}
