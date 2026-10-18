import assert from "node:assert/strict";
import test from "node:test";
import { view } from "../edge-gateway/resolve-cache-stream-fixtures.mjs";
import { c4RebuildReady } from "./c4-rebuild.mjs";

function fixture() {
  const before = {
    agent_id: "agent-1",
    availability: "ready",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    active_session_id: null,
    unavailable_reason: null,
  };
  const after = { ...before, configuration_revision: "b".repeat(64) };
  const current = {
    ...view("session-1", "cursor"),
    availability: "ready",
    activeSessionId: null,
  };
  return { before, after, current };
}

test("C4 Rebuild uses the private revision while the public view contains only Bridge fields", () => {
  const { before, after, current } = fixture();
  assert.equal(Object.hasOwn(current, "configuration_revision"), false);
  assert.equal(
    c4RebuildReady(before, after, current, "agent-1", "session-1"),
    true,
  );
});

test("a ready browser view cannot substitute for the unchanged private Rebuild revision", () => {
  const { before, current } = fixture();
  assert.equal(
    c4RebuildReady(before, { ...before }, current, "agent-1", "session-1"),
    false,
  );
});

test("Rebuild cannot claim retained history after losing its original Session and returning to a draft", () => {
  const { before, after } = fixture();
  const draft = {
    ...view(null, "cursor"),
    availability: "ready",
    activeSessionId: null,
  };
  assert.throws(() => c4RebuildReady(before, after, draft, "agent-1", null));
  assert.throws(() =>
    c4RebuildReady(before, after, draft, "agent-1", "session-1"),
  );
});

for (const [label, mutate] of [
  [
    "private execution offline",
    ({ after }) => {
      after.availability = "offline";
      after.unavailable_reason = "agent_unavailable";
    },
  ],
  [
    "private execution busy",
    ({ after }) => {
      after.availability = "busy";
      after.active_session_id = "session-1";
    },
  ],
  [
    "Bridge still offline",
    ({ current }) => {
      current.availability = "offline";
    },
  ],
  [
    "Bridge still busy",
    ({ current }) => {
      current.availability = "busy";
      current.activeSessionId = "session-1";
    },
  ],
  [
    "Bridge still has an active Session",
    ({ current }) => {
      current.activeSessionId = "session-1";
    },
  ],
])
  test(`a changed private revision does not finish Rebuild with ${label}`, () => {
    const data = fixture();
    mutate(data);
    assert.equal(
      c4RebuildReady(
        data.before,
        data.after,
        data.current,
        "agent-1",
        "session-1",
      ),
      false,
    );
  });

for (const [label, mutate] of [
  [
    "revoked member",
    ({ after }) => {
      Object.assign(after, {
        access_allowed: false,
        availability: "offline",
        active_session_id: null,
        configuration_revision: null,
        unavailable_reason: "access_denied",
      });
    },
  ],
  [
    "foreign private Agent",
    ({ after }) => {
      after.agent_id = "foreign";
    },
  ],
  [
    "invalid private revision",
    ({ after }) => {
      after.configuration_revision = undefined;
    },
  ],
  [
    "foreign Bridge Agent",
    ({ current }) => {
      current.agentId = "foreign";
      current.selectedView.agentId = "foreign";
    },
  ],
  [
    "foreign Bridge Session",
    ({ current }) => {
      current.selectedSessionId = "foreign";
      current.selectedView.sessionId = "foreign";
    },
  ],
  [
    "private fields in the Bridge",
    ({ current }) => {
      current.configuration_revision = "c".repeat(64);
    },
  ],
  [
    "invalid initial Agent",
    ({ before }) => {
      before.agent_id = "foreign";
    },
  ],
  [
    "busy initial execution",
    ({ before }) => {
      before.availability = "busy";
      before.active_session_id = "session-1";
    },
  ],
])
  test(`C4 Rebuild refuses ${label}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() =>
      c4RebuildReady(
        data.before,
        data.after,
        data.current,
        "agent-1",
        "session-1",
      ),
    );
  });
